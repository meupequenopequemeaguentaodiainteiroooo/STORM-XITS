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
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import config from './config.js';
import { generatePixPayload } from './pix.js';
import { pool, initDb } from './db.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Exibe o catálogo de produtos'),
  new SlashCommandBuilder()
    .setName('painel-atendimento')
    .setDescription('Envia o painel de plantão para atendentes (Somente Creator/Creator 2)'),
  new SlashCommandBuilder()
    .setName('pedidos')
    .setDescription('Exibe os pedidos pendentes (Somente Creator/Creator 2)')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

client.once('ready', async () => {
  console.log(`🤖 Bot online como: ${client.user.tag}`);
  await initDb();
  
  try {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('✅ Comandos registrados!');
  } catch (error) {
    console.error('❌ Erro nos comandos:', error);
  }
});

client.on('interactionCreate', async (interaction) => {

  if (interaction.isChatInputCommand()) {
    
    if (interaction.commandName === 'painel-atendimento') {
      const member = interaction.member;
      const hasPermission = member.roles.cache.some(role => config.permittedRoles.includes(role.name));
      if (!hasPermission) return interaction.reply({ content: '❌ Apenas Creator/Creator 2 podem usar.', ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle('🎧 Controlar Plantão de Atendimento')
        .setDescription('Entre na fila para receber os Pix das próximas vendas de forma automática (rodízio).')
        .setColor('#3498DB');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('atendente_on').setLabel('🟢 Ficar On (Entrar na Fila)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('atendente_off').setLabel('🔴 Ficar Off (Sair da Fila)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('atendente_status').setLabel('📊 Ver Fila').setStyle(ButtonStyle.Secondary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: '✅ Painel enviado com sucesso!', ephemeral: true });
    }

    if (interaction.commandName === 'comprar') {
      await interaction.deferReply({ ephemeral: true });

      const res = await pool.query('SELECT * FROM produtos ORDER BY id ASC');
      const produtos = res.rows;
      if (!produtos || produtos.length === 0) return interaction.editReply('❌ Nenhum produto cadastrado.');

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
          new ButtonBuilder().setCustomId(`prev_${pageIndex}`).setLabel('◀ Anterior').setStyle(ButtonStyle.Secondary).setDisabled(pageIndex === 0),
          new ButtonBuilder().setCustomId(`buy_${item.id}`).setLabel('🛒 Comprar').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`next_${pageIndex}`).setLabel('Próximo ▶').setStyle(ButtonStyle.Secondary).setDisabled(pageIndex === produtos.length - 1)
        );
        return { embeds: [embed], components: [row] };
      };

      const response = await interaction.editReply(createCatalogMessage(currentPage));
      const collector = response.createMessageComponentCollector({ time: 120000 });

      collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) return i.reply({ content: 'Use seu próprio catálogo.', ephemeral: true });

        if (i.customId.startsWith('prev_')) {
          currentPage--;
          await i.update(createCatalogMessage(currentPage));
        } else if (i.customId.startsWith('next_')) {
          currentPage++;
          await i.update(createCatalogMessage(currentPage));
        } else if (i.customId.startsWith('buy_')) {
          const produtoId = i.customId.split('_')[1];
          await i.deferUpdate();

          const atendenteRes = await pool.query('SELECT * FROM atendentes ORDER BY entered_at ASC LIMIT 1');
          if (atendenteRes.rows.length === 0) {
            return i.followUp({ content: '❌ Nenhum atendente está online no momento. Tente novamente em instantes.', ephemeral: true });
          }

          const atendente = atendenteRes.rows[0];

          await pool.query('UPDATE atendentes SET entered_at = CURRENT_TIMESTAMP WHERE user_id = $1', [atendente.user_id]);

          const prodRes = await pool.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
          const produto = prodRes.rows[0];

          const pedRes = await pool.query(
            'INSERT INTO pedidos (user_id, user_tag, produto_id, valor, atendente_id, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [i.user.id, i.user.username, produto.id, produto.preco, atendente.user_id, 'PENDENTE']
          );
          const pedido = pedRes.rows[0];

          const guild = i.guild;
          const channel = await guild.channels.create({
            name: `carrinho-${i.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
              { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
              { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
              { id: atendente.user_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
          });

          const pixPayload = generatePixPayload({
            chave: atendente.chave_pix,
            nome: config.pix.nome,
            cidade: config.pix.cidade,
            valor: produto.preco,
            txid: i.user.username
          });

          const pixEmbed = new EmbedBuilder()
            .setTitle(`💳 Pagamento - Pedido #${pedido.id}`)
            .setDescription(`Produto: **${produto.nome}**
Atendente Responsável: <@${atendente.user_id}>

**Valor:** R$ ${Number(produto.preco).toFixed(2)}

Use o **Pix Copia e Cola** abaixo:`)
            .setColor('#2ECC71');

          await channel.send({ content: `<@${i.user.id}> | Atendente: <@${atendente.user_id}>`, embeds: [pixEmbed] });
          await channel.send(`\`\`\`${pixPayload}\`\`\``);

          await i.followUp({ content: `✅ Carrinho criado: ${channel}`, ephemeral: true });
        }
      });
    }

    if (interaction.commandName === 'pedidos') {
      const member = interaction.member;
      const hasPermission = member.roles.cache.some(role => config.permittedRoles.includes(role.name));
      if (!hasPermission) return interaction.reply({ content: '❌ Apenas Creator/Creator 2 podem usar.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      const queryText = `
        SELECT p.id, p.user_id, p.user_tag, p.valor, p.atendente_id, prod.nome as produto_nome
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
            { name: 'Atendente', value: `<@${p.atendente_id}>`, inline: true },
            { name: 'Produto', value: p.produto_nome || 'Desconhecido', inline: true },
            { name: 'Valor', value: `R$ ${Number(p.valor).toFixed(2)}`, inline: true }
          )
          .setColor('#F1C40F');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_${p.id}`).setLabel('✅ Confirmar Compra').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`deny_${p.id}`).setLabel('❌ Recusar Compra').setStyle(ButtonStyle.Danger)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
      }

      await interaction.editReply('📋 Lista de pedidos carregada no canal.');
    }
  }

  if (interaction.isButton()) {
    const customId = interaction.customId;

    if (customId === 'atendente_on') {
      const modal = new ModalBuilder().setCustomId('modal_pix').setTitle('Cadastrar na Fila de Atendimento');
      const pixInput = new TextInputBuilder().setCustomId('chave_pix_input').setLabel('Sua Chave Pix para receber as vendas').setStyle(TextInputStyle.Short).setPlaceholder('CPF, e-mail, telefone ou aleatória').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(pixInput));
      await interaction.showModal(modal);
    }

    if (customId === 'atendente_off') {
      await pool.query('DELETE FROM atendentes WHERE user_id = $1', [interaction.user.id]);
      await interaction.reply({ content: '🔴 Você saiu da fila de atendimento.', ephemeral: true });
    }

    if (customId === 'atendente_status') {
      const res = await pool.query('SELECT * FROM atendentes ORDER BY entered_at ASC');
      if (res.rows.length === 0) return interaction.reply({ content: '📋 Nenhum atendente na fila no momento.', ephemeral: true });

      let lista = res.rows.map((a, index) => `${index + 1}º - <@${a.user_id}> (${a.user_tag})`).join('
');
      const embed = new EmbedBuilder().setTitle('📋 Fila Atual de Atendimento').setDescription(lista).setColor('#F1C40F');
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId.startsWith('confirm_') || customId.startsWith('deny_')) {
      const [action, pedidoId] = customId.split('_');
      const member = interaction.member;
      const hasPermission = member.roles.cache.some(role => config.permittedRoles.includes(role.name));

      if (!hasPermission) {
        return interaction.reply({ content: '❌ Você não tem permissão para gerenciar este pedido.', ephemeral: true });
      }

      const isApproved = action === 'confirm';
      const newStatus = isApproved ? 'APROVADO' : 'RECUSADO';

      const updateRes = await pool.query('UPDATE pedidos SET status = $1 WHERE id = $2 RETURNING *', [newStatus, pedidoId]);
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

  if (interaction.isModalSubmit() && interaction.customId === 'modal_pix') {
    const chavePix = interaction.fields.getTextInputValue('chave_pix_input');

    await pool.query(
      `INSERT INTO atendentes (user_id, user_tag, chave_pix, entered_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET chave_pix = EXCLUDED.chave_pix, entered_at = CURRENT_TIMESTAMP`,
      [interaction.user.id, interaction.user.username, chavePix]
    );

    await interaction.reply({ content: `🟢 Você entrou na fila! Sua chave Pix (\`${chavePix}\`) será usada nas vendas.`, ephemeral: true });
  }
});

client.login(config.token);
