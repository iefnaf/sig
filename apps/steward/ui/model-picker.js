import { h, icon } from './dom.js';
import { t } from './i18n.js';

/** A bounded, searchable choice list; native buttons keep pointer and keyboard behavior equal. */
export function modelPicker(models, selected, onSelect, options = {}) {
  const { name = 'model', compact = false, searchable = true, disabled = false, label, leadingIcon, minWidth = 0 } = options;
  const current = models.find((model) => model.id === selected);
  const results = h('div', { class: 'model-options', role: 'group', 'aria-label': label ?? t('modelIdLabel') });
  const search = h('input', { id: `${name}-search`, type: 'search', placeholder: t('modelSearch'), 'aria-label': t('modelSearch'), autocomplete: 'off', spellcheck: 'false' });
  const count = h('span', { class: 'model-match-count', role: 'status', 'aria-live': 'polite' });
  const panel = h('div', { id: `${name}-choices`, class: 'model-choices', popover: 'auto' },
    searchable ? h('label', { class: 'model-search' }, icon('search'), search) : null, results, searchable ? count : null);
  const trigger = h('button', { id: `${name}-picker-trigger`, type: 'button', class: `model-picker-trigger${compact ? ' model-choice-chip' : ''}`, disabled, 'aria-label': label, title: label, 'aria-expanded': 'false', 'aria-controls': `${name}-choices` },
    leadingIcon ? icon(leadingIcon) : null, h('span', null, h('strong', null, current?.name ?? (selected || t('modelChoose'))),
      !compact && searchable && current && current.name !== current.id ? h('small', null, current.id) : null), icon('chevron-down'));
  const close = () => { panel.hidePopover(); trigger.focus(); };
  panel.addEventListener('toggle', (event) => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
  const draw = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = models.filter((model) => words.every((word) => `${model.name} ${model.id} ${model.group ?? ""}`.toLowerCase().includes(word)));
    const rows = [];
    let group;
    for (const model of matches) {
      if (model.group && model.group !== group) {
        group = model.group;
        rows.push(h('div', { class: 'model-group-heading' }, group));
      }
      rows.push(h('button', {
        type: 'button', class: 'model-option', 'aria-pressed': String(model.id === selected), dataset: { model: model.id },
        onclick: () => { panel.hidePopover(); onSelect(model.id); },
      }, h('span', null, h('strong', null, model.name), searchable && !model.group && model.name !== model.id ? h('small', null, model.id) : null), model.id === selected ? icon('check') : null));
    }
    results.replaceChildren(...rows);
    if (!matches.length) results.append(h('p', { class: 'model-no-results' }, t('modelNoMatches')));
    count.textContent = t('modelMatches', { count: matches.length });
  };
  trigger.addEventListener('click', () => {
    if (panel.matches(':popover-open')) return close();
    search.value = '';
    draw();
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, minWidth), innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    results.style.maxHeight = `${Math.min(240, innerHeight - 130)}px`;
    panel.showPopover();
    const height = panel.getBoundingClientRect().height;
    const top = rect.bottom + height + 6 <= innerHeight - 12 ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
    panel.style.top = `${top}px`;
    if (searchable && !matchMedia('(pointer: coarse)').matches) search.focus();
    if (!searchable) results.querySelector('[aria-pressed="true"]')?.focus();
    results.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  search.addEventListener('input', draw);
  const root = h('div', { class: `model-picker${compact ? ' compact' : ''}` }, trigger, panel);
  root.addEventListener('keydown', (event) => {
    if (!panel.matches(':popover-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    const options = [...results.querySelectorAll('button')];
    if (event.key === 'Enter' && event.target === search) { event.preventDefault(); options[0]?.click(); return; }
    const index = options.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) : index < 0 ? options.length - 1 : index - 1;
      (options[next] ?? (searchable ? search : trigger)).focus();
    }
  });
  return root;
}
