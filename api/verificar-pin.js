// Valida o PIN no servidor ANTES de liberar a interface.
// Isso impede que alguém sem o PIN veja a tela e o conteúdo do app.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { pin } = req.body || {};

  if (!process.env.SITE_PIN) {
    return res.status(500).json({ erro: 'PIN não configurado no servidor' });
  }

  // Pequeno atraso para dificultar tentativa automatizada de adivinhar o PIN
  await new Promise(r => setTimeout(r, 400));

  if (!pin || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ ok: false, erro: 'PIN incorreto' });
  }

  return res.status(200).json({ ok: true });
}
