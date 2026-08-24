function formatField(id, value) {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}

export function generatePixPayload({ chave, nome, cidade, valor, txid }) {
  const cleanTxid = txid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || 'DISCORD';
  const valorStr = Number(valor).toFixed(2);

  const merchantAccount = 
    formatField('00', 'BR.GOV.BCB.PIX') +
    formatField('01', chave);

  const additionalData = formatField('05', cleanTxid);

  let payload = 
    formatField('00', '01') +
    formatField('26', merchantAccount) +
    formatField('52', '0000') +
    formatField('53', '986') +
    formatField('54', valorStr) +
    formatField('58', 'BR') +
    formatField('59', nome.slice(0, 25)) +
    formatField('60', cidade.slice(0, 15)) +
    formatField('62', additionalData) +
    '6304';

  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xFFFF;
    }
  }

  const crcHex = (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  return payload + crcHex;
}
