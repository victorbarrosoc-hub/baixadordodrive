// Conteúdo dos Primeiros passos. Fica separado para poder ser revisado sem mexer na tela.
// Links abrem em nova aba. Os textos falam com quem nunca abriu o Console do Google.

export const SETUP_STEPS = [
  {
    id: 'chave',
    short: 'Chave',
    title: 'Crie sua chave de acesso no Google',
    lead:
      'O SOBEDESCE conversa direto com o Google a partir deste computador — nada passa por outros servidores. ' +
      'Para isso ele usa uma chave sua. Leva uns cinco minutos e é uma vez só.',
    checklist: [
      {
        title: 'Crie um projeto',
        detail: 'Qualquer nome serve — por exemplo, “SOBEDESCE”.',
        href: 'https://console.cloud.google.com/projectcreate',
        cta: 'Criar projeto',
      },
      {
        title: 'Ative a Google Drive API',
        detail: 'Com o projeto novo selecionado, clique em “Ativar”.',
        href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
        cta: 'Ativar a API',
      },
      {
        title: 'Configure a tela de consentimento',
        detail: 'Preencha o nome do app (pode ser SOBEDESCE) e o seu e-mail de contato.',
        href: 'https://console.cloud.google.com/auth/branding',
        cta: 'Configurar',
      },
      {
        title: 'Escolha o público',
        detail:
          'Marque “Externo” e adicione seu e-mail como usuário de teste. Depois clique em “Publicar app” — assim o acesso não expira a cada 7 dias.',
        href: 'https://console.cloud.google.com/auth/audience',
        cta: 'Abrir público',
      },
      {
        title: 'Crie o cliente e baixe o JSON',
        detail: 'Clique em “Criar cliente”, escolha o tipo “App para computador” e baixe o arquivo JSON.',
        href: 'https://console.cloud.google.com/auth/clients',
        cta: 'Criar cliente',
      },
    ],
    next: 'Já baixei o JSON',
  },
  {
    id: 'colar',
    short: 'Colar',
    title: 'Cole a chave',
    lead: 'Arraste para cá o arquivo JSON que você baixou. Ele fica guardado só neste computador.',
    drop: {
      title: 'Solte o arquivo JSON aqui',
      hint: 'ou clique para escolher — costuma estar em Downloads, com um nome tipo client_secret_….json',
    },
    manual: {
      toggle: 'Prefiro colar o Client ID e o secret',
      clientId: 'Client ID',
      clientIdPlaceholder: '1234567890-abc….apps.googleusercontent.com',
      clientSecret: 'Client secret',
      clientSecretPlaceholder: 'GOCSPX-…',
      submit: 'Salvar chave',
    },
  },
  {
    id: 'conectar',
    short: 'Conectar',
    title: 'Conecte sua conta Google',
    lead: 'Você escolhe a conta no Google e autoriza o acesso ao Drive. Dá para conectar outras contas depois.',
    button: 'Conectar com o Google',
    note: {
      title: 'Vai aparecer “O Google não verificou este app”',
      body: 'É esperado: o app é seu, com a sua chave. Clique em “Avançado” e depois em “Acessar SOBEDESCE (não seguro)”. É seguro.',
      clicks: ['Avançado', 'Acessar SOBEDESCE (não seguro)'],
    },
  },
]
