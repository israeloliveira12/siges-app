/* ============================================================================
   Plataforma SaaS — Início (Fase 2: stub). Só existe pra quem é
   platform_owner (App.profile.platform_owner). Gestão de tenants, planos e
   métricas chegam nas próximas fases.
   ============================================================================ */

async function renderPlataformaInicio() {
  const root = document.getElementById('screen-plataforma-inicio');
  root.innerHTML = `
    <div class="card" style="text-align:center;padding:60px 24px">
      <h2>Painel da Plataforma SaaS</h2>
      <p class="text-soft mt-8">Em construção — a gestão de empresas clientes, planos e métricas chega nas próximas fases.</p>
    </div>
  `;
}

registerRoute('plataforma/inicio', {
  role: 'plataforma',
  screenId: 'plataforma-inicio',
  title: 'Plataforma SaaS',
  render: renderPlataformaInicio,
});
