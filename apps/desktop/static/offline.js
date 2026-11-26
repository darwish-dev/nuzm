/* global document, window, location, URL, URLSearchParams */
// Local page shown when the console cannot be reached. Bundled with the app, so it works with no network.
(function () {
  var text = {
    ar: {
      title: 'تعذّر الوصول إلى نُظم AI',
      body: 'تحقّق من اتصالك بالإنترنت ثم أعد المحاولة. لم يُفقد شيء من عملك على الخادم.',
      retry: 'إعادة المحاولة',
      other: 'English',
      trying: 'جارٍ إعادة المحاولة…',
    },
    en: {
      title: 'Can’t reach Nuzm AI',
      body: 'Check your internet connection and try again. Nothing you saved on the server is lost.',
      retry: 'Try again',
      other: 'العربية',
      trying: 'Trying again…',
    },
  };
  var q = new URLSearchParams(location.search);
  var locale = q.get('lang') === 'en' ? 'en' : 'ar';
  var retryUrl = q.get('retry') || '';

  function render() {
    var t = text[locale];
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.title = t.title;
    document.querySelectorAll('[data-t]').forEach(function (el) {
      el.textContent = t[el.getAttribute('data-t')];
    });
    document.getElementById('lang').textContent = t.other;
    document.getElementById('lang').setAttribute('lang', locale === 'ar' ? 'en' : 'ar');
    document.getElementById('origin').textContent = q.get('origin') || '';
  }

  function retry() {
    document.getElementById('status').textContent = text[locale].trying;
    var target = retryUrl;
    if (target) {
      var u = new URL(target);
      u.searchParams.set('lang', locale);
      target = u.toString();
    }
    if (window.nuzmDesktop) window.nuzmDesktop.retry(target);
  }

  document.getElementById('retry').addEventListener('click', retry);
  document.getElementById('lang').addEventListener('click', function () {
    locale = locale === 'ar' ? 'en' : 'ar';
    render();
  });
  window.addEventListener('online', retry);
  render();
  document.getElementById('retry').focus();
})();
