import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes, SlashCommandBuilder } from 'discord.js';
import config from './config.js';
import { pool, initDb } from './db.js';
import { gerarPixPayload } from './pix.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

async function getNextAttendant() {
  const queue = await pool.query('SELECT * FROM fila WHERE status = $1 ORDER BY pos ASC', ['online']);
  if (queue.rows.length === 0) return null;
  const selected = queue.rows[0];
  const maxPosRes = await pool.query('SELECT MAX(pos) as max_pos FROM fila');
  const nextPos = (maxPosRes.rows[0].max_pos || 0) + 1;
  await pool.query('UPDATE fila SET pos = $1 WHERE user_id = $2', [nextPos, selected.user_id]);
  return selected;
}

client.once('ready', async () => {
  await initDb();
  
  const commands = [
    new SlashCommandBuilder()
      .setName('painel-atendimento')
      .setDescription('Abre o painel de gerenciamento da fila de atendimento'),
    new SlashCommandBuilder()
      .setName('comprar')
      .setDescription('Abre o catálogo para comprar produtos')
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  try {
    console.log('🔄 Registrando comandos Slash no Discord...');
    await rest.put(
      Routes.applicationCommands(config.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Comandos registrados com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos:', error);
  }

  console.log(`🤖 Bot online como: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'painel-atendimento') {
      if (!interaction.member.roles.cache.has(config.ROLE_CRIADOR_ID)) {
        return interaction.reply({ content: 'Você não tem permissão para usar este comando.', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle('🎧 Painel de Atendimento - Fila de Criadores')
        .setDescription('Gerencie sua disponibilidade na fila de vendas.')
        .setColor('#5865F2');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('queue_on').setLabel('🟢 Ficar On (Entrar na Fila)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('queue_off').setLabel('🔴 Ficar Off (Sair da Fila)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('queue_list').setLabel('📜 Ver Fila').setStyle(ButtonStyle.Secondary)
      );

      return interaction.reply({ embeds: [embed], components: [row] });
    }

    if (commandName === 'comprar') {
      const produtos = await pool.query('SELECT * FROM produtos');
      if (produtos.rows.length === 0) {
        return interaction.reply({ content: 'Nenhum produto cadastrado no momento.', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle('🛒 Catálogo de Produtos')
        .setDescription('Selecione um produto para comprar:')
        .setColor('#2F3136');

      const row = new ActionRowBuilder();
      produtos.rows.forEach((p) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`buy_${p.id}`)
            .setLabel(`${p.nome} - R$ ${p.preco}`)
            .setStyle(ButtonStyle.Primary)
        );
      });

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'queue_on') {
      if (!interaction.member.roles.cache.has(config.ROLE_CRIADOR_ID)) {
        return interaction.reply({ content: 'Apenas Criadores podem entrar na fila!', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId('modal_pix')
        .setTitle('Configurar sua Chave Pix');

      const pixInput = new TextInputBuilder()
        .setCustomId('pix_key')
        .setLabel('Sua chave Pix para receber os pagamentos')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('CPF, CNPJ, Email, Telefone ou Aleatória')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(pixInput));
      return interaction.showModal(modal);
    }

    if (customId === 'queue_off') {
      await pool.query('UPDATE fila SET status = $1 WHERE user_id = $2', ['offline', interaction.user.id]);
      return interaction.reply({ content: '🔴 Você saiu da fila de atendimento.', ephemeral: true });
    }

    if (customId === 'queue_list') {
      const res = await pool.query("SELECT * FROM fila WHERE status = 'online' ORDER BY pos ASC");
      if (res.rows.length === 0) {
        return interaction.reply({ content: 'Nenhum atendente online na fila no momento.', ephemeral: true });
      }

      let lista = res.rows.map((a, index) => `${index + 1}º - <@${a.user_id}> (${a.user_tag})`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('📜 Fila Atual de Atendimento')
        .setDescription(lista)
        .setColor('#FEE75C');

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId.startsWith('buy_')) {
      const prodId = customId.split('_')[1];
      const prodRes = await pool.query('SELECT * FROM produtos WHERE id = $1', [prodId]);
      if (prodRes.rows.length === 0) {
        return interaction.reply({ content: 'Produto não encontrado.', ephemeral: true });
      }
      const produto = prodRes.rows[0];

      const atendente = await getNextAttendant();
      if (!atendente) {
        return interaction.reply({ content: 'Nenhum atendente disponível no momento. Tente novamente em instantes!', ephemeral: true });
      }

      const pixData = gerarPixPayload(atendente.pix_key, produto.preco);

      const orderRes = await pool.query(
        'INSERT INTO pedidos (cliente_id, produto_id, valor, atendente_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [interaction.user.id, produto.id, produto.preco, atendente.user_id, 'pendente']
      );
      const orderId = orderRes.rows[0].id;

      const embed = new EmbedBuilder()
        .setTitle(`📌 Pedido #${orderId} - ${produto.nome}`)
        .setDescription(`**Valor:** R$ ${produto.preco}\n**Atendente:** <@${atendente.user_id}>\n\nCopie o código Pix abaixo para efetuar o pagamento:`)
        .setColor('#57F287');

      return interaction.reply({
        embeds: [embed],
        content: `\`\`\`${pixData.payload}\`\`\``,
        ephemeral: true
      });
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_pix') {
      const pixKey = interaction.fields.getTextInputValue('pix_key');
      const maxPosRes = await pool.query('SELECT MAX(pos) as max_pos FROM fila');
      const nextPos = (maxPosRes.rows[0].max_pos || 0) + 1;

      await pool.query(
        `INSERT INTO fila (user_id, user_tag, pix_key, status, pos)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE 
         SET pix_key = EXCLUDED.pix_key, status = 'online', pos = EXCLUDED.pos`,
        [interaction.user.id, interaction.user.tag, pixKey, 'online', nextPos]
      );

      return interaction.reply({ content: `🟢 Você entrou na fila de atendimento! Chave Pix cadastrada: \`${pixKey}\``, ephemeral: true });
    }
  }
});

client.login(config.DISCORD_TOKEN);
