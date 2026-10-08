/* Floating contact buttons (bottom-right, every page).
   >>> Edit the three links below — this is the only place they live. <<< */
(function () {
  var LINKS = {
    whatsapp:  'https://wa.me/918008383699',
    instagram: 'https://www.instagram.com/dr_ragadeepthi/',
    linkedin:  'https://www.linkedin.com/company/for-her-wellbeing/posts/'
  };

  var css =
    '.social-float{position:fixed;right:26px;bottom:26px;z-index:80;width:54px;display:flex;flex-direction:column;align-items:center;gap:12px;}' +
    '.social-float a{display:flex;align-items:center;justify-content:center;border-radius:50%;text-decoration:none;box-shadow:0 8px 20px rgba(0,0,0,0.25);transition:transform .2s ease;}' +
    '.social-float a:hover,.social-float a:focus-visible{transform:translateY(-3px);}' +
    '.social-float .sf-wa{width:54px;height:54px;background:#2E6B3E;}' +
    '.social-float .sf-ig{width:46px;height:46px;background:#6C3159;}' +
    '.social-float .sf-in{width:46px;height:46px;background:#3B1530;}' +
    '.social-float svg{width:22px;height:22px;}' +
    '.social-float .sf-wa svg{width:24px;height:24px;}' +
    '@media(max-width:600px){.social-float{right:16px;bottom:16px;}}';

  var icons = {
    linkedin: '<svg viewBox="0 0 24 24" fill="white"><rect x="3" y="9" width="4" height="12"/><circle cx="5" cy="4.8" r="2.2"/><path d="M10 9h3.8v1.7c.6-1.1 2-2 3.9-2 3.6 0 4.3 2.4 4.3 5.4V21h-4v-5.8c0-1.4 0-3.1-1.9-3.1s-2.1 1.5-2.1 3V21h-4z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="1.1" fill="white" stroke="none"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="white"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.44 1.32 4.94L2 22l5.31-1.39a9.9 9.9 0 0 0 4.73 1.2h.01c5.46 0 9.9-4.45 9.9-9.9C21.96 6.45 17.5 2 12.04 2Zm5.8 14.03c-.24.68-1.4 1.3-1.93 1.37-.5.07-1.1.1-1.78-.11-.41-.13-.94-.3-1.61-.6-2.85-1.23-4.7-4.1-4.84-4.29-.14-.19-1.16-1.55-1.16-2.95 0-1.4.73-2.09.99-2.37.26-.28.58-.35.77-.35h.55c.18 0 .42-.03.65.5.25.6.85 2.08.92 2.23.07.15.12.32.02.51-.1.19-.15.31-.3.48-.15.17-.31.38-.44.5-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.02 1.12.99 2.06 1.3 2.35 1.45.29.15.46.13.63-.08.17-.21.72-.84.92-1.13.19-.29.38-.24.64-.14.26.1 1.65.78 1.94.92.28.14.47.21.53.33.07.12.07.68-.17 1.36Z"/></svg>'
  };

  function link(cls, href, label, icon) {
    return '<a class="' + cls + '" href="' + href + '" target="_blank" rel="noopener" aria-label="' + label + '" title="' + label + '">' + icon + '</a>';
  }

  function init() {
    // remove the old WhatsApp-only button if a page still has it
    document.querySelectorAll('.wa-float').forEach(function (el) { el.remove(); });
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    var box = document.createElement('div');
    box.className = 'social-float';
    box.innerHTML =
      link('sf-in', LINKS.linkedin, 'LinkedIn', icons.linkedin) +
      link('sf-ig', LINKS.instagram, 'Instagram', icons.instagram) +
      link('sf-wa', LINKS.whatsapp, 'WhatsApp', icons.whatsapp);
    document.body.appendChild(box);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
