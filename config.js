import 'dotenv/config';

export default {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  databaseUrl: process.env.DATABASE_URL,

  pix: {
    chave: process.env.PIX_CHAVE,
    nome: process.env.PIX_NOME || 'RECEBEDOR',
    cidade: process.env.PIX_CIDADE || 'SAO PAULO'
  },

  permittedRoles: ['Creator', 'Creator 2']
};
