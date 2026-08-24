import pg from 'pg';
import config from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export async function initDb() {
  const queryText = `
    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      descricao TEXT NOT NULL,
      preco NUMERIC(10, 2) NOT NULL,
      imagem_url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      user_tag VARCHAR(255) NOT NULL,
      produto_id INT REFERENCES produtos(id),
      valor NUMERIC(10, 2) NOT NULL,
      status VARCHAR(50) DEFAULT 'PENDENTE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await pool.query(queryText);
  console.log('✅ Banco de dados PostgreSQL inicializado com sucesso.');
}
