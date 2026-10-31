(() => {
  'use strict';

  const services = document.getElementById('services');
  if (!services) return;

  const tabs = Array.from(services.querySelectorAll('.service-grid .service-tab[role="tab"]'));
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  const cards = tabs.map(tab => tab.closest('.service-card'));

  function select(index) {
    tabs.forEach((tab, position) => {
      const active = position === index;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      cards[position].classList.toggle('service-card-featured', active);
      panels[position].hidden = !active;
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      let next;
      switch (event.key) {
        case 'ArrowRight':
          next = (index + 1) % tabs.length;
          break;
        case 'ArrowLeft':
          next = (index - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      select(next);
      tabs[next].focus();
    });
  });

  select(tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
})();
