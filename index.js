import { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionFlagsBits, 
  ChannelType 
} from 'discord.js';
import config from './config.js';
import { generatePixPayload } from './pix.js';
import { pool, initDb } from './db.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Exibe o catálogo de produtos com paginação'),
  new SlashCommandBuilder()
    .setName('pedidos')
    .setDescription('Exibe a lista de pedidos pendentes (Somente Creator e Creator 2)')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

client.once('ready', async () => {
  console.log(`🤖 Bot online como: ${client.user.tag}`);
  await initDb();
  
  try {
    console.log('🔄 Registrando comandos Slash...');
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands }
    );
    console.log('✅ Comandos Slash registrados com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    
    if (interaction.commandName === 'comprar') {
      await interaction.deferReply({ ephemeral: true });

      const res = await pool.query('SELECT * FROM produtos ORDER BY id ASC');
      const produtos = res.rows;

      if (!produtos || produtos.length === 0) {
        return interaction.editReply('❌ Nenhum produto cadastrado no catálogo.');
      }

      let currentPage = 0;

      const createCatalogMessage = (pageIndex) => {
        const item = produtos[pageIndex];

        const embed = new EmbedBuilder()
          .setTitle(`📦 ${item.nome}`)
          .setDescription(item.descricao)
          .addFields({ name: '💰 Preço', value: `R$ ${Number(item.preco).toFixed(2)}` })
          .setImage(item.imagem_url)
          .setColor('#5865F2')
          .setFooter({ text: `Produto ${pageIndex + 1} de ${produtos.length}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`prev_${pageIndex}`)
            .setLabel('◀ Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIndex === 0),
          new ButtonBuilder()
            .setCustomId(`buy_${item.id}`)
            .setLabel('🛒 Comprar')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`next_${pageIndex}`)
            .setLabel('Próximo ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIndex === produtos.length - 1)
        );

        return { embeds: [embed], components: [row] };
      };

      const response = await interaction.editReply(createCatalogMessage(currentPage));
      const collector = response.createMessageComponentCollector({ time: 120000 });

      collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({ content: 'Use o seu próprio comando /comprar.', ephemeral: true });
        }

        if (i.customId.startsWith('prev_')) {
          currentPage--;
          await i.update(createCatalogMessage(currentPage));
        } else if (i.customId.startsWith('next_')) {
          currentPage++;
          await i.update(createCatalogMessage(currentPage));
        } else if (i.customId.startsWith('buy_')) {
          const produtoId = i.customId.split('_')[1];
          await i.deferUpdate();

          const prodRes = await pool.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
          const produto = prodRes.rows[0];
          if (!produto) return;

          const pedRes = await pool.query(
            'INSERT INTO pedidos (user_id, user_tag, produto_id, valor, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [i.user.id, i.user.username, produto.id, produto.preco, 'PENDENTE']
          );
          const pedido = pedRes.rows[0];

          const guild = i.guild;
          const channel = await guild.channels.create({
            name: `carrinho-${i.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
              { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
              { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
          });

          const pixPayload = generatePixPayload({
            chave: config.pix.chave,
            nome: config.pix.nome,
            cidade: config.pix.cidade,
            valor: produto.preco,
            txid: i.user.username
          });

          const pixEmbed = new EmbedBuilder()
            .setTitle(`💳 Pagamento - Pedido #${pedido.id}`)
            .setDescription(`Você selecionou **${produto.nome}**.

**Valor:** R$ ${Number(produto.preco).toFixed(2)}

Utilize o **Pix Copia e Cola** abaixo para efetuar o pagamento:`)
            .setColor('#2ECC71');

          await channel.send({ content: `<@${i.user.id}>`, embeds: [pixEmbed] });
          await channel.send(`\`\`\`${pixPayload}\`\`\``);

          await i.followUp({ content: `✅ Seu carrinho privado foi criado: ${channel}`, ephemeral: true });
        }
      });
    }

    if (interaction.commandName === 'pedidos') {
      const member = interaction.member;
      const hasPermission = member.roles.cache.some(role => config.permittedRoles.includes(role.name));

      if (!hasPermission) {
        return interaction.reply({ 
          content: '❌ Apenas usuários com o cargo **Creator** ou **Creator 2** podem utilizar este comando.', 
          ephemeral: true 
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const queryText = `
        SELECT p.id, p.user_id, p.user_tag, p.valor, prod.nome as produto_nome
        FROM pedidos p
        JOIN produtos prod ON p.produto_id = prod.id
        WHERE p.status = 'PENDENTE'
        ORDER BY p.id ASC
      `;
      const pedRes = await pool.query(queryText);
      const pedidos = pedRes.rows;

      if (!pedidos || pedidos.length === 0) {
        return interaction.editReply('📋 Nenhum pedido pendente encontrado.');
      }

      for (const p of pedidos) {
        const embed = new EmbedBuilder()
          .setTitle(`📝 Pedido #${p.id}`)
          .addFields(
            { name: 'Cliente', value: `<@${p.user_id}> (${p.user_tag})`, inline: true },
            { name: 'Produto', value: p.produto_nome || 'Desconhecido', inline: true },
            { name: 'Valor', value: `R$ ${Number(p.valor).toFixed(2)}`, inline: true }
          )
          .setColor('#F1C40F');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_${p.id}`)
            .setLabel('✅ Confirmar Compra')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`deny_${p.id}`)
            .setLabel('❌ Recusar Compra')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
      }

      await interaction.editReply('📋 Lista de pedidos carregada no canal.');
    }
  }

  if (interaction.isButton()) {
    const [action, pedidoId] = interaction.customId.split('_');

    if (action === 'confirm' || action === 'deny') {
      const member = interaction.member;
      const hasPermission = member.roles.cache.some(role => config.permittedRoles.includes(role.name));

      if (!hasPermission) {
        return interaction.reply({ content: '❌ Você não tem permissão para gerenciar este pedido.', ephemeral: true });
      }

      const isApproved = action === 'confirm';
      const newStatus = isApproved ? 'APROVADO' : 'RECUSADO';

      const updateRes = await pool.query(
        'UPDATE pedidos SET status = $1 WHERE id = $2 RETURNING *',
        [newStatus, pedidoId]
      );
      const pedido = updateRes.rows[0];

      if (pedido) {
        try {
          const user = await client.users.fetch(pedido.user_id);
          if (isApproved) {
            await user.send(`🎉 Seu pedido **#${pedido.id}** foi **APROVADO**! Obrigado pela compra.`);
          } else {
            await user.send(`❌ Seu pedido **#${pedido.id}** foi **RECUSADO**.`);
          }
        } catch (_) {}

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(isApproved ? '#2ECC71' : '#E74C3C')
          .setFooter({ text: `Status: ${newStatus} por ${interaction.user.username}` });

        await interaction.update({ embeds: [updatedEmbed], components: [] });
      }
    }
  }
});

client.login(config.token);
