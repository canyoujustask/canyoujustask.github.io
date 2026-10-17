import './project-content.css';

export function connectProjectContent() {
  // Detail-page return links open the same project in the existing list.
  const openHashProject = () => {
    const project = document.getElementById(location.hash.slice(1));
    if (project instanceof HTMLDetailsElement && project.classList.contains('project')) {
      project.open = true;
    }
  };
  openHashProject();
  window.addEventListener('hashchange', openHashProject);

  const link = document.querySelector<HTMLAnchorElement>('[data-research]');
  if (!link) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'research-dialog';
  dialog.setAttribute('aria-labelledby', 'research-dialog-title');
  const toolbar = document.createElement('div');
  toolbar.className = 'research-toolbar';
  const title = document.createElement('h2');
  title.id = 'research-dialog-title';
  title.textContent = 'Makale ve tez — araştırma katkısı';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'research-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Araştırma görselini kapat');
  const imageHost = document.createElement('div');
  imageHost.className = 'research-image';
  toolbar.append(title, closeButton);
  dialog.append(toolbar, imageHost);
  document.body.append(dialog);

  link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const image = new Image(2400, 2735);
    image.src = link.href;
    image.alt = 'Onaylı makale ve tez araştırma katkısı özeti, doğrudan alıntılar, ses analiz kolajı ve kaynakça';
    imageHost.replaceChildren(image);
    dialog.showModal();
    imageHost.scrollTop = 0;
    document.body.classList.add('research-open');
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    imageHost.replaceChildren();
    document.body.classList.remove('research-open');
    link.focus({ preventScroll: true });
  });
}
