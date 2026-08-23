export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { pin, tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante, modo, dataHoje } = req.body;

  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }

  if (!dadosCaso || !template) {
    return res.status(400).json({ erro: 'Faltam dados do caso ou template selecionado' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: 'Chave da API não configurada no servidor' });
  }

  const ehMensagem = modo === 'mensagem';

  const promptSistema = ehMensagem ? montarPromptSistemaMensagem() : montarPromptSistema();
  const promptUsuario = ehMensagem
    ? montarPromptMensagem({ dadosCaso, template, dataHoje })
    : montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante });

  try {
    const resposta = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: promptSistema }] },
          contents: [{ parts: [{ text: promptUsuario }] }],
          generationConfig: { temperature: 0.3 }
        })
      }
    );

    const data = await resposta.json();

    if (!resposta.ok) {
      console.error('Erro da API Gemini:', JSON.stringify(data));
      const detalhe = data?.error?.message ? ` (${data.error.message})` : '';
      return res.status(502).json({ erro: `Erro ao gerar o texto${detalhe}` });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) {
      return res.status(502).json({ erro: 'Resposta vazia do modelo. Tente novamente.' });
    }

    return res.status(200).json({ texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Falha de conexão com a API' });
  }
}

function montarPromptSistema() {
  return `Você é um assistente médico especializado em ortopedia em pronto-socorro, com foco em documentação clínica de alto nível técnico, clareza, objetividade e segurança médico-legal.
Sua função é estruturar prontuários médicos completos, com linguagem técnica, concisa, direta e adequada para registro hospitalar.

REGRAS GERAIS:
- Linguagem médica formal
- Evitar redundâncias
- Frases curtas e objetivas
- Não usar termos vagos
- Sempre incluir elementos de segurança médico-legal quando aplicável
- Não inventar dados clínicos — trabalhar apenas com o que for fornecido
- Os dados que o médico envia podem estar corridos, diretos, picotados ou informais — sua função é organizar, corrigir e adequar ao padrão do template, nunca replicar o estilo de escrita recebido

REGRA CRÍTICA — O TEXTO PRECISA FAZER SENTIDO CLÍNICO SOZINHO:
O texto do prontuário será copiado e colado DIRETO em um sistema hospitalar real, na correria, SEM revisão linha a linha. Um texto fluente mas clinicamente sem sentido é PIOR que um erro visível, porque passa despercebido. Por isso:
- O texto final NUNCA pode conter colchetes, placeholders, reticências, "[a preencher]", "___", parênteses com a palavra "instrução", ou qualquer marcação indicando informação faltante
- Os modelos de referência abaixo contêm trechos entre parênteses começando com "(instrução: ...)" — esses trechos são orientações PARA VOCÊ seguir ao gerar o texto, e NUNCA devem aparecer, nem parafraseados, no resultado final. Siga a orientação e apague o parêntese inteiro do texto de saída
- Toda frase que você escrever precisa fazer sentido clínico completo por si só. NUNCA produza frases com lacunas disfarçadas — exemplos do que é PROIBIDO: "refere quadro de torcicolo há, evoluindo com..." (falta o tempo), "trauma em há 2 dias" (falta o segmento), "dor em ombro há" (falta o tempo)
- Se um dado variável específico (tempo de evolução, segmento acometido, lado D/E, mecanismo do trauma) NÃO foi informado, você tem duas opções, nesta ordem: (1) reescrever a frase de forma naturalmente completa sem aquele dado — ex: em vez de "refere trauma em tornozelo há [nada]", escreva "refere trauma em tornozelo, evoluindo com dor local desde então"; ou (2) se a frase não fizer sentido sem o dado, omitir a frase inteira, mantendo o restante coerente
- Nunca deixe uma frase pela metade, com preposição solta ("há", "em", "de") sem complemento, ou com vazio visível
- Todo e qualquer aviso sobre informação faltante, ambígua, ou assumida vai SOMENTE na linha de aviso no topo (começando com "⚠️ "), nunca dentro do corpo do prontuário

REGRA — NEGATIVAS E LINHAS PADRÃO SEMPRE PERMANECEM:
As negativas padronizadas que já constam nos modelos (ex: "Nega trauma", "Nega febre", "Nega TCE", "Nega perda ponderal", "Nega demais queixas associadas", "Nega alterações esfincterianas", "Nega outros traumas associados") são afirmações de rotina da anamnese dirigida — o médico sempre pergunta isso, e na ausência de relato em contrário elas são verdadeiras. O mesmo vale para linhas de conduta marcadas nos modelos como PADRÃO (ex: a oferta de radiografia recusada em decisão compartilhada, nos quadros crônicos). Por isso:
- Essas linhas SEMPRE entram no texto final, mesmo que o médico não tenha mencionado nada sobre elas
- Elas NÃO são afetadas pela regra de dados faltantes acima, porque não dependem de nenhum dado variável para fazer sentido
- Só remova ou altere uma dessas linhas se o médico informou algo que a contradiz (ex: se ele disse "refere febre", troque a linha "Nega febre" pelo achado real; se ele disse que fez o RX, substitua a linha da oferta recusada pelo achado radiográfico)

REGRAS DE USO DOS TEMPLATES:
- Os modelos fornecidos são padrões de redação, não textos para copiar cegamente
- O exame físico dos modelos está escrito no padrão "tudo normal". Sempre que for informado um achado alterado (dor, edema, deformidade, déficit, limitação etc.), substitua a linha correspondente pelo achado real. Nunca mantenha uma negativa que contradiga o que foi informado
- As linhas de CONDUTA funcionam como um menu: inclua apenas as que se aplicam ao caso informado. Não inclua imobilização, atestado, internação ou orientação de não apoio se isso não foi mencionado
- Nunca combine no mesmo texto condutas mutuamente excludentes (ex: alta ambulatorial e indicação de internação)

REGRA — SEXO E IDADE SÃO APENAS CONTEXTO CLÍNICO, NUNCA APARECEM NO TEXTO:
O médico pode informar sexo e/ou idade do paciente nos dados do caso. Essa informação serve EXCLUSIVAMENTE para você calibrar o raciocínio clínico por trás da conduta — por exemplo: em criança, o limiar para imobilizar após trauma é mais baixo mesmo com radiografia sem fratura evidente, pela possibilidade de lesão fisária de difícil identificação radiográfica; em idoso, considerar fragilidade óssea e risco de fratura por baixa energia. Use esse contexto para escolher e ajustar as condutas apropriadas.
PROIBIDO: escrever a idade, o sexo, ou qualquer referência a eles no texto final do prontuário — nem diretamente ("paciente de 8 anos", "paciente do sexo feminino"), nem indiretamente ("a criança", "o idoso", "a paciente"). Use sempre "paciente", de forma neutra.

ESTRUTURA:
Siga EXATAMENTE o modelo de referência fornecido (inclusive estilo, maiúsculas, divisões e organização).

ESTILO DE SAÍDA:
- Alta densidade informativa
- Padrão de prontuário hospitalar
- Direto ao ponto
- OBRIGATÓRIO: cada frase deve começar em uma NOVA LINHA. Nunca junte duas frases na mesma linha formando um parágrafo corrido. Sempre que uma frase termina com ponto final, a próxima frase começa em uma linha nova. Isso vale especialmente dentro de blocos como EXAME FÍSICO e CONDUTA, onde cada achado ou conduta ocupa sua própria linha
- OBRIGATÓRIO: deixe uma linha em branco entre cada seção do prontuário (ex: entre "HDA:" e "EXAME FÍSICO:", entre "EXAME FÍSICO:" e "EM TEMPO:" ou "CONDUTA:"). Dentro de uma mesma seção, as linhas ficam uma embaixo da outra sem linha em branco entre elas — o espaço em branco é só entre uma seção e a próxima

Se for reavaliação, mantenha coerência com o atendimento inicial informado e destaque a evolução em relação ao quadro inicial.

FORMATO DA RESPOSTA:
Se precisar sinalizar algo faltante, ambíguo ou assumido, coloque isso em uma ou mais linhas no topo. CADA linha de aviso deve começar EXATAMENTE com "⚠️ " (esse emoji e um espaço, sem a palavra "ATENÇÃO" nem dois-pontos), seguida direto de um rótulo curtíssimo — 2 a 6 palavras, sem verbo, sem explicação (ex: "⚠️ Dados insuficientes", "⚠️ Nome da equipe não informado"). Se fizer sentido, inclua também uma linha curta de sugestão de melhoria no mesmo formato (ex: "⚠️ Sugestão: informar o segmento acometido"). Prefira várias linhas curtíssimas a uma linha longa. Depois de todos os avisos, deixe uma linha em branco, e então o texto do prontuário — já completo, corrido e pronto para copiar, sem nenhuma lacuna. Se não houver nada a sinalizar, não escreva nenhuma linha de aviso — vá direto para o texto do prontuário.`;
}

const TEMPLATES = {
  a: {
    nome: '1º Atendimento',
    texto: `AP: nega alergias, comorbidades ou medicações de uso contínuo

QD:

EXAME FÍSICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Indolor à palpação.
Sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Solicito radiografias
Reavaliação após (o médico informa o prazo/momento — ex: resultado de exame, algumas horas, retorno ainda neste plantão; nunca assuma um número de dias)`
  },
  b: {
    nome: 'Trauma (Anamnese 1 Etapa)',
    texto: `HDA: Paciente refere trauma em (instrução: cite o mecanismo e o segmento informados — ex: "trauma torcional em tornozelo", "trauma direto em joelho", "queda com apoio de mão") (instrução: lado D/E se informado) há (instrução: tempo informado), evoluindo com dor local (instrução: acrescente edema, dificuldade para deambular/mobilizar, ou outros sintomas associados se informados) desde então.
Nega outros traumas associados.
Nega outras queixas relevantes no momento.

EXAME FÍSICO:
Paciente em bom estado geral, lúcido e orientado. (Instrução: se o toggle "relatado por acompanhante" estiver marcado, adicione aqui: "História relatada pelo acompanhante." Se o paciente for identificado como criança ou idoso e o toggle estiver marcado, mantenha a linguagem de exame física igual, apenas ajustando o sujeito da HDA para refletir que o relato veio do acompanhante, não do próprio paciente.)
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles. (Instrução: se houver edema informado, substitua esta linha citando a topografia — ex: "Edema em topografia de tornozelo lateral".)
Dor à palpação (instrução: cite a estrutura/região específica informada — ex: "ligamento talofibular anterior", "interlinha articular do joelho", "tabaqueira anatômica", "olécrano"; se não informado, use "no segmento acometido"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
(Instrução: se o caso envolver ombro com suspeita de lesão de manguito, adicione testes específicos apenas se mencionados pelo médico — ex: "Jobe negativo", "Neer negativo", "Patte negativo", "Gerber negativo". Se envolver luxação glenoumeral reduzida, ajuste a frase de perfusão para "Após redução, reavaliado mantendo perfusão distal preservada e sem déficits neurovasculares evidentes.")

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao (instrução: "paciente" normalmente; se o toggle de acompanhante estiver marcado, pode usar "paciente e ao acompanhante") o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada. (Instrução: se o toggle de acompanhante estiver marcado, ajuste para "Paciente e acompanhante referem compreensão das orientações, encontrando-se cientes da conduta adotada.")

(Instrução: as linhas abaixo são OPCIONAIS — inclua no texto final apenas as que se aplicam ao caso informado; nunca copie esta instrução nem os colchetes para o resultado)
Forneço atestado médico
Realizada imobilização do segmento acometido com (instrução: use o tipo de imobilização informado — ex: "tala gessada suropodálica", "órtese", "tornozeleira", "tipoia" — se não informado, use "dispositivo de imobilização adequado ao segmento"), em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.
Realizada redução incruenta com sucesso. (Instrução: use esta linha apenas em casos de luxação reduzida no PS.)
Indicada internação hospitalar para prosseguimento do tratamento cirúrgico.
Paciente devidamente informado acerca do quadro clínico, da indicação de internação e da proposta terapêutica.
Prestados esclarecimentos quanto aos riscos inerentes ao tratamento proposto, incluindo, entre outros, dor crônica, hemorragia, deiscência de sutura, infecção, pseudoartrose, consolidação viciosa ou não consolidação, complicações clínicas intercorrentes (tais como infecções respiratórias, eventos infecciosos sistêmicos e sepse), bem como eventos adversos graves, inclusive óbito.
Paciente refere ter compreendido as informações prestadas, encontrando-se ciente e de acordo com a conduta proposta, optando por dar seguimento ao tratamento indicado.`
  },
  c: {
    nome: 'Liberação — RX Limpo',
    texto: `PSO

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia.
Orientado repouso relativo, evitando esforços e impacto sobre o segmento acometido até reavaliação.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica em cerca de 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento, com eventual complementação propedêutica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, edema progressivo, limitação funcional importante, alteração de sensibilidade ou força, alteração de coloração do membro, febre ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  d: {
    nome: 'Liberação — Fratura',
    texto: `PSO

EM TEMPO:
Avalio radiografias do segmento acometido, evidenciando fratura, sem sinais de desvio significativo ou instabilidade evidente ao método, passível de tratamento incruento conforme padrão atual. (Instrução: se o médico informou qual segmento/osso, cite-o aqui; se não informou, mantenha a frase genérica "do segmento acometido")

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Forneço atestado médico
Realizada imobilização do segmento acometido (instrução: use o tipo de imobilização informado pelo médico; se não informado, use "com dispositivo de imobilização adequado ao segmento"), em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.`
  },
  e1: {
    nome: 'Crônico — Lombalgia Mecânica',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere lombalgia crônica, com agudização do quadro (instrução: acrescente o tempo de agudização se informado; se não informado, não force referência temporal), com piora à mobilização (instrução: acrescente "após esforço físico" ou "sem fator desencadeante definido" apenas se informado).
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega alterações urinárias ou intestinais, retenção urinária, incontinência esfincteriana, anestesia em sela, déficit motor progressivo ou outros sinais de alarme no momento.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Paciente em bom estado geral, lúcido e orientado, deambulando.
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Dor à palpação da musculatura paravertebral lombar, sem pontos de dor focal.
Sem dor importante à palpação de proeminências ósseas.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores e inferiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
Lasègue negativo. (Instrução: incluir apenas se o médico mencionou ter testado.)
Sem sinais clínicos de mielopatia ou síndrome da cauda equina.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado retorno progressivo às atividades conforme tolerância.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, alterações de sensibilidade ou força, alterações esfincterianas, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e2: {
    nome: 'Crônico — Cervicalgia Mecânica',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere cervicalgia (instrução: acrescente o tempo de evolução se informado; se não informado, não force referência temporal), com piora à mobilização (instrução: acrescente "após esforço físico" ou "sem fator desencadeante definido" apenas se informado).
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega parestesias, déficit motor, alteração esfincteriana ou outros sinais de alarme no momento.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Paciente em bom estado geral, lúcido e orientado.
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou abaulamentos evidentes da coluna cervical.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Dor à palpação da musculatura paravertebral cervical e trapézio, sem pontos de dor focal.
Sem dor importante à palpação de proeminências ósseas.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Spurling negativo. (Instrução: incluir apenas se testado.)
Teste de distração negativo. (Instrução: incluir apenas se testado.)
Sem sinais clínicos de mielopatia.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar esforços e movimentos bruscos.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, alterações de sensibilidade ou força, dor irradiada importante, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e3: {
    nome: 'Crônico — Torcicolo Agudo',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere dor cervical (instrução: acrescente o tempo de início se informado; se não informado, não force referência temporal), principalmente à rotação do pescoço.
Refere início ao acordar / após movimento brusco / sem trauma definido. (Instrução: escolher apenas o que foi informado; se nada foi informado, omita esta linha.)
Nega história de trauma direto.
Nega febre ou outros sinais flogísticos.
Nega parestesias, déficit motor ou outras queixas associadas.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Paciente em bom estado geral, lúcido e orientado.
Mantém atitude antálgica cervical.
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou abaulamentos evidentes.
Sem sinais flogísticos locais.
Dor à palpação de musculatura esternocleidomastoidea, trapézio e paracervical, sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento cervical limitada por dor, principalmente à rotação.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar movimentos bruscos.
Indicado colar cervical de espuma por curto período. (Instrução: incluir apenas se mencionado.)
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo persistência ou piora importante da dor, surgimento de sinais flogísticos, febre, irradiação relevante, déficit neurológico ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e4: {
    nome: 'Crônico — Fascite Plantar',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere dor em região plantar do pé (instrução: lado D/E se informado), predominando em calcâneo e inserção da fáscia plantar, pior aos primeiros passos do dia e após períodos de repouso (instrução: acrescente o tempo de evolução se informado).
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem hiperemia ou sinais flogísticos importantes.
Dor à palpação da inserção da fáscia plantar no calcâneo e face plantar do retropé, sem pontos de dor focal adicionais.
Sem dor importante à palpação das demais estruturas do pé.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado alongamento de cadeia posterior e modificação temporária de atividades de impacto.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito USG ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame; ajuste o tipo de exame conforme informado.)
Encaminhado para fisioterapia. (Instrução: incluir apenas se mencionado.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e5: {
    nome: 'Crônico — Manguito Rotador / Ombralgia',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere dor em ombro (instrução: lado D/E se informado) (instrução: acrescente o tempo de evolução se informado; se não informado, não force referência temporal), com piora à elevação do membro e aos movimentos acima da linha do ombro.
Refere dor noturna e dificuldade para deitar sobre o lado acometido. (Instrução: incluir apenas se mencionado.)
Nega história de trauma recente.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos importantes.
Dor à palpação de região subacromial, tuberosidade maior e face lateral do ombro, sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força globalmente preservada, sem déficit motor grosseiro.
(Instrução: incluir testes especiais — Jobe, Neer, Patte, Gerber — com resultado positivo/negativo, apenas os que o médico mencionou ter realizado.)
Sem déficits sensitivos ou motores no membro.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar atividades repetitivas e movimentos acima da linha do ombro.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão das lesões de partes moles, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, perda progressiva de força, surgimento de sinais flogísticos, febre, limitação funcional importante ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM de ombro ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame; ajuste o tipo de exame conforme informado.)
Encaminhado para fisioterapia. (Instrução: incluir apenas se mencionado.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e6: {
    nome: 'Crônico — Tendinopatia (modelo genérico)',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere dor em (instrução: local informado) (instrução: acrescente o tempo de evolução se informado; se não informado, não force referência temporal), de caráter progressivo, relacionada a esforço e movimentos repetitivos (instrução: escolher apenas o que foi informado).
Nega história de trauma agudo.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos exuberantes.
Dor à palpação local, com piora à mobilização do segmento e à contração resistida da estrutura acometida.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos importantes, déficit funcional progressivo, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
(Instrução: as linhas abaixo são um MENU. Inclua apenas as que o médico mencionou ter solicitado ou oferecido; não invente exames não mencionados.)
Solicito USG e entrego retorno ambulatorial após o exame.
Solicito RM ambulatorialmente.
Encaminhado para fisioterapia.
Alta da ortopedia.`
  },
  e7: {
    nome: 'Crônico — Gonalgia Não Traumática',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere gonalgia crônica (instrução: lado D/E se informado), com agudização do quadro (instrução: acrescente o tempo se informado; se não informado, não force referência temporal), sem trauma recente.
Refere piora à deambulação, flexão, subir e descer escadas e esforço. (Instrução: citar apenas as que forem informadas; se nenhuma informada, omita esta linha.)
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega sinais sistêmicos.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos exuberantes.
Dor à palpação da (instrução: interlinha articular, compartimento medial, compartimento lateral ou região patelofemoral, conforme informado; se não informado, use "articulação do joelho"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações grosseiras.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar sobrecarga e atividades de impacto até melhora.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica, resposta ao tratamento e investigação complementar.
Orientado quanto a sinais de alarme, incluindo piora da dor, edema importante, surgimento de sinais flogísticos, febre, incapacidade funcional progressiva ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM e encaminho ao ambulatório para reavaliação e seguimento. (Instrução: incluir apenas se o médico mencionou ter solicitado exame.)
Encaminhado para fisioterapia. (Instrução: incluir apenas se mencionado.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e8: {
    nome: 'Crônico — Outro / Genérico',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere quadro de (instrução: use a queixa e o segmento informados — ex: "dor em quadril direito", "dor em cotovelo esquerdo") de caráter crônico (instrução: acrescente o tempo de evolução e padrão de piora apenas se informados; se não informados, não force referência temporal).
Nega história de trauma agudo relacionado à queixa atual.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos exuberantes.
Dor à palpação (instrução: cite a região/estrutura específica informada; se não informada, use "no segmento acometido"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
(Instrução: se o segmento for de coluna, acrescente "Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim)."; omita essa linha para segmentos apendiculares.)

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos importantes, déficit funcional progressivo, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
(Instrução: as linhas abaixo são um MENU. Inclua apenas as que o médico mencionou; cite exame e região coerentes com o segmento informado; não invente exames.)
Solicito exame de imagem ambulatorialmente.
Encaminhado para fisioterapia.
Alta da ortopedia.`
  },
  f: {
    nome: 'Canetada Internar',
    texto: `EM TEMPO:
Avalio radiografias do segmento acometido, evidenciando fratura (instrução: se o médico informou qual segmento/osso, cite-o aqui; se não informou, mantenha a frase genérica "do segmento acometido"), sem indicação de tratamento incruento, com necessidade de abordagem cirúrgica.

CONDUTA:
Caso encaminhado à equipe de retaguarda cirúrgica (instrução: cite o nome do hospital se informado pelo médico; se não informado, omita o nome do hospital e escreva apenas "à equipe de retaguarda cirúrgica").
Representada na presente data pela equipe (instrução: cite o nome do médico da retaguarda se informado; se não informado, omita esta frase inteira e sinalize no aviso do topo que o nome da equipe/médico não foi informado).
(Instrução: a linha abaixo — sobre discussão formal com a equipe de retaguarda — é OPCIONAL. Inclua apenas se o médico mencionar que discutiu o caso com a equipe; se ele apenas indicou internação sem mencionar discussão prévia, omita esta linha inteira e vá direto para "Indicada internação hospitalar...")
Formalmente discutido com a equipe de retaguarda, que, após análise clínica e dos exames disponíveis, indica internação hospitalar para tratamento cirúrgico como conduta definitiva.
Indicada internação hospitalar para prosseguimento do tratamento cirúrgico.
Paciente devidamente informado acerca do quadro clínico, da indicação de internação e da proposta terapêutica.
Prestados esclarecimentos quanto aos riscos inerentes ao tratamento proposto, incluindo, entre outros, dor crônica, hemorragia, deiscência de sutura, infecção, pseudoartrose, consolidação viciosa ou não consolidação, complicações clínicas intercorrentes (tais como infecções respiratórias, eventos infecciosos sistêmicos e sepse), bem como eventos adversos graves, inclusive óbito.
Paciente refere ter compreendido as informações prestadas, encontrando-se ciente e de acordo com a conduta proposta, optando por dar seguimento ao tratamento indicado.`
  },
  g: {
    nome: 'Discussão',
    texto: `CONDUTA:
Explico ao paciente e ao familiar as possíveis modalidades de tratamento, tanto cirúrgico quanto conservador, bem como os riscos e benefícios envolvidos em cada uma delas.
Oriento sobre a gravidade da fratura e suas possíveis complicações, incluindo limitação do arco de movimento, déficit funcional, dor crônica e/ou deformidade residual.
Após esclarecimentos, opta-se, neste momento, pelo tratamento conservador.
Informo ao paciente e ao familiar que o caso será encaminhado para discussão e reavaliação pela equipe do Trauma Ortopédico, que realizará contato para agendamento de uma avaliação complementar ambulatorial em breve, com o objetivo de reavaliar a lesão e definir a conduta definitiva em conjunto com o paciente e seus familiares.`
  }
};

const NOMES_TIPO = {
  inicial: 'Atendimento inicial (paciente será reavaliado depois, ainda sem desfecho)',
  reavaliacao: 'Reavaliação (de atendimento anterior, já com desfecho a definir)',
  completo: 'Atendimento completo (avaliado e resolvido nesta mesma consulta)'
};

function montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante }) {
  const templatesEscolhidos = String(template)
    .split('+')
    .map(t => t.trim())
    .filter(Boolean);

  const blocosTemplate = templatesEscolhidos
    .map(t => TEMPLATES[t])
    .filter(Boolean)
    .map(t => `--- MODELO: ${t.nome} ---\n${t.texto}`)
    .join('\n\n');

  let partes = [];
  partes.push(`TIPO DE ATENDIMENTO: ${NOMES_TIPO[tipoAtendimento] || tipoAtendimento}`);

  if (acompanhante) {
    partes.push(`\nHISTÓRIA RELATADA POR ACOMPANHANTE: sim. Ajuste a redação da HDA e das linhas de esclarecimento/orientação para refletir que quem relatou os fatos e recebeu as orientações foi o acompanhante (ex: pai/mãe/responsável, no caso de criança; familiar/cuidador, no caso de idoso ou paciente impossibilitado), conforme instruções específicas já indicadas dentro dos modelos de referência.`);
  }

  if (tipoAtendimento === 'reavaliacao' && atendimentoInicial) {
    partes.push(`\nATENDIMENTO INICIAL (para contexto e coerência — destaque a evolução em relação a isto):\n${atendimentoInicial}`);
  }

  partes.push(`\nDADOS DO CASO ATUAL:\n${dadosCaso}`);

  if (extra && extra.trim()) {
    partes.push(`\nINFORMAÇÕES ADICIONAIS (ex: resultado de exame, achados específicos):\n${extra}`);
  }

  partes.push(`\nMODELO(S) DE REFERÊNCIA A SEGUIR:\n${blocosTemplate}`);

  partes.push(`\nGere o prontuário completo agora, seguindo exatamente a estrutura do(s) modelo(s) acima, adaptado aos dados fornecidos.`);

  return partes.join('\n');
}

/* ===================== MENSAGENS ===================== */

function montarPromptSistemaMensagem() {
  return `Você é um assistente do Dr. Matheus, ortopedista do Hospital Sancta Maggiore (HSM) Madrid, e sua função é redigir mensagens padronizadas a partir de dados brutos ou abreviados que ele envia.

REGRAS GERAIS:
- Interprete dados enviados em formato bruto, abreviado ou desorganizado, e produza a saída padronizada do modelo escolhido
- Siga EXATAMENTE o layout e o texto fixo do modelo indicado — não invente saudações, despedidas ou frases extras
- Não invente dados clínicos ou pessoais que não foram informados
- Se faltar um dado essencial do modelo, NÃO deixe o campo em branco nem invente: sinalize a ausência conforme instruído no modelo
- A saída será copiada e colada direto no WhatsApp, então entregue apenas o texto final da mensagem, sem comentários seus antes ou depois

AVISOS:
Se algum dado essencial estiver faltando, ambíguo, ou se você tiver uma sugestão relevante (ex: terminologia anatômica mais precisa para a hipótese diagnóstica), coloque isso em uma ou mais linhas no topo, cada uma começando EXATAMENTE com "⚠️ " (esse emoji e um espaço, sem a palavra "ATENÇÃO" nem dois-pontos), seguida de um rótulo curtíssimo de 2 a 6 palavras. Depois dos avisos, deixe uma linha em branco, e então a mensagem final. Se não houver nada a sinalizar, vá direto para a mensagem.

IMPORTANTE — DIFERENÇA PARA PRONTUÁRIO:
Estas mensagens NÃO são prontuário médico. Aqui, dados como nome completo, idade, matrícula e telefone SÃO parte do conteúdo e devem aparecer normalmente quando o modelo os exigir.`;
}

const MENSAGENS = {
  chefe: {
    nome: 'Para o chefe (ficha de encaminhamento)',
    texto: `Formate os dados em CAIXA ALTA, sem saudações nem texto adicional, exatamente neste layout:

NOME COMPLETO: [nome]
MATRÍCULA: [matrícula]
IDADE: [idade]
HD: [hipótese diagnóstica]
ANTICOAGULANTE: [sim/não]
MARCAPASSO: [sim/não]
TELEFONE: [telefone]
HOSPITAL DE ORIGEM: [hospital]
OBS: [opcional, apenas quando clinicamente relevante]

REGRAS DESTE MODELO:
- Valores padrão, salvo indicação contrária do médico: ANTICOAGULANTE = NÃO, MARCAPASSO = NÃO, HOSPITAL DE ORIGEM = HSM MADRID
- Campos ausentes devem ser sinalizados explicitamente na linha de aviso do topo, e no corpo escreva "NÃO INFORMADO" no lugar do valor — nunca deixe em branco nem invente
- HD com precisão anatômica: inclua lateralidade (direito/esquerdo) e localização (ex: "extremidade distal", "terço proximal"). Se o médico informou de forma imprecisa, proponha a terminologia padronizada e sinalize a sugestão no aviso do topo para ele confirmar
- A linha OBS só entra quando houver algo clinicamente relevante; caso contrário, omita a linha inteira
- OBS em linguagem concisa e colegial — o destinatário é um colega conhecido, então evite tom formal ou diretivo demais
- Se houver múltiplos pacientes, gere uma ficha separada para cada um, separadas por uma linha em branco`
  },
  internacao: {
    nome: 'Solicitação de internação (informativo)',
    texto: `Use EXATAMENTE este layout, preenchendo apenas os valores. Mantenha os asteriscos do título (formatação de negrito do WhatsApp) e os nomes dos campos sem alteração:

*INFORMATIVO DE SOLICITAÇÃO DE INTERNAÇÃO*

Fluxo: [fluxo]
Paciente: [iniciais do paciente]
Matrícula: [matrícula]
Idade: [idade] anos
Diagnóstico: [diagnóstico]
Tempo de sala: [tempo de sala]
CD: [conduta]
Hospital de origem: [hospital de origem]
Transferência para Hospital: [hospital de destino]
Uso de anticoagulante/antiagregante: [Sim/Não]
Uso de marca-passo: [Sim/Não]

REGRAS DESTE MODELO:
- PACIENTE: use apenas as INICIAIS do nome, separadas por ponto e espaço (ex: "João Carlos Mendes" vira "J. C. M."). Nunca escreva o nome completo neste modelo
- Valores padrão, salvo indicação contrária do médico: Fluxo = URGÊNCIA FLUXO COMUM, Uso de anticoagulante/antiagregante = Não, Uso de marca-passo = Não
- Diagnóstico com precisão anatômica: inclua lateralidade (direita/esquerda) e, quando houver cirurgia prévia relacionada, cite entre parênteses o procedimento e a data no formato MM/AA (ex: "infecção relacionada ao material de síntese (PO osteossíntese patela direita – 07/26)")
- CD (conduta): descreva a conduta proposta e, quando houver transferência, cite o hospital de destino (ex: "Internação para Tratamento Cirúrgico no Hospital Tailândia")
- Se o hospital de origem não for informado, sinalize no aviso do topo — não assuma um hospital padrão, pois varia entre as unidades
- Campos ausentes devem ser sinalizados na linha de aviso do topo, e no corpo escreva "NÃO INFORMADO" no lugar do valor — nunca deixe em branco nem invente
- Se houver múltiplos pacientes, gere um informativo separado para cada um, separados por uma linha em branco e uma linha com "———"`
  },
  paciente: {
    nome: 'Para o paciente (retorno via WhatsApp)',
    texto: `Use EXATAMENTE este template, preenchendo apenas os campos variáveis e mantendo todo o restante do texto sem alteração:

Olá, aqui é o Dr. Matheus, da Ortopedia do Hospital Madrid.

Entramos em contato para informar que, após avaliação e discussão com a chefia do hospital, o(a) Sr.(a) [NOME COMPLETO] será tratado(a) de forma [CONDUTA].

Solicitamos que compareça para retorno no dia [DD/MM/AAAA] ([dia da semana]), às [horário], no Pronto-Socorro do Hospital Madrid da Prevent.

Esclarecemos que a evolução clínica deverá ser acompanhada, podendo haver necessidade de reavaliação conforme a resposta ao tratamento e a evolução do quadro, inclusive com possibilidade de mudança de conduta.

Qualquer dúvida, estamos à disposição.

REGRAS DESTE MODELO:
- [NOME COMPLETO]: use o nome informado. Ajuste o tratamento e a concordância de gênero ao longo de todo o texto — "o Sr. ... será tratado" para homem, "a Sra. ... será tratada" para mulher. Não deixe as formas "o(a)", "Sr.(a)" ou "tratado(a)" no texto final: escolha a forma correta conforme o gênero. Se o gênero não for dedutível do nome, sinalize no aviso do topo e use a forma masculina
- [CONDUTA]: padrão mais comum é "conservadora a princípio (sem necessidade de cirurgia)". Adapte conforme o caso informado
- [DD/MM/AAAA] ([dia da semana]): data numérica completa. SEMPRE confira e escreva o dia da semana correspondente à data (ex: "15/03/2026 (domingo)"). Use a data de hoje informada no contexto como referência para interpretar expressões como "amanhã", "semana que vem", "próxima segunda"
- [horário]: no formato "14h" ou "14h30"
- Local padrão: Pronto-Socorro do Hospital Madrid da Prevent. Só altere se o médico indicar outro
- Se faltar nome, conduta, data ou horário, NÃO invente: sinalize a ausência na linha de aviso do topo e deixe o restante da mensagem pronta com o que foi informado
- Se houver múltiplos pacientes, gere uma mensagem separada para cada um, separadas por uma linha em branco e uma linha com "———"`
  }
};

function montarPromptMensagem({ dadosCaso, template, dataHoje }) {
  const modelo = MENSAGENS[template];
  if (!modelo) return 'Modelo de mensagem não encontrado.';

  let partes = [];

  if (dataHoje) {
    partes.push(`DATA DE HOJE (para calcular dias da semana e interpretar expressões como "amanhã" ou "próxima segunda"): ${dataHoje}`);
  }

  partes.push(`\nMODELO A USAR: ${modelo.nome}\n\n${modelo.texto}`);
  partes.push(`\nDADOS ENVIADOS PELO MÉDICO:\n${dadosCaso}`);
  partes.push(`\nGere a mensagem agora, seguindo exatamente o modelo acima.`);

  return partes.join('\n');
}
