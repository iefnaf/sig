i18n.apply();
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-locale]');
  if (button && i18n.setLocale(button.dataset.locale)) i18n.apply();
});
window.addEventListener('storage', (event) => {
  if (event.key === 'pip.locale' && i18n.setLocale(event.newValue === 'zh' ? 'zh' : 'en')) i18n.apply();
});
