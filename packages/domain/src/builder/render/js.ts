/**
 * The ONLY script of generated sites: first-party, no eval, no dynamic code, no innerHTML. Loaded with `<script src defer>` (CSP script-src 'self').
 * Without JS the menu is simply always visible and forms post normally.
 */
export const SITE_JS = `(function () {
  'use strict';
  document.documentElement.classList.add('js');

  var toggle = document.querySelector('.nav-toggle');
  var list = document.getElementById('site-nav');
  if (toggle && list) {
    list.setAttribute('data-open', 'false');
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      list.setAttribute('data-open', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  var forms = document.querySelectorAll('form[data-success]');
  Array.prototype.forEach.call(forms, function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.fetch || !window.FormData || !window.URLSearchParams) return;
      event.preventDefault();
      var status = document.getElementById(form.getAttribute('data-status'));
      var button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      var headers = { Accept: 'application/json' };
      if (window.crypto && window.crypto.randomUUID) {
        form.__key = form.__key || window.crypto.randomUUID();
        headers['Idempotency-Key'] = form.__key;
      }
      fetch(form.action, {
        method: 'POST',
        headers: headers,
        body: new URLSearchParams(new FormData(form)),
        credentials: 'omit'
      })
        .then(function (response) {
          if (!response.ok) throw new Error('status ' + response.status);
          form.reset();
          form.__key = null;
          if (button) button.disabled = false;
          if (status) {
            status.textContent = form.getAttribute('data-success');
            status.focus();
          }
        })
        .catch(function () {
          if (button) button.disabled = false;
          form.submit();
        });
    });
  });
})();
`;
