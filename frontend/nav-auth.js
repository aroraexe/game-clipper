(function () {
  'use strict';

  function initNavAuth() {
    var API_BASE = (window.__API_BASE__ || '').replace(/\/$/, '');
    var userEmail = localStorage.getItem('userEmail');

    var navSignIn = document.getElementById('navSignIn');
    var navCreateBtn = document.getElementById('navCreateBtn');
    var heroCreateBtn = document.getElementById('heroCreateBtn');
    var userMenu = document.getElementById('userMenu');
    var userEmailEl = document.getElementById('user-dropdown-email');
    var userAvatarEl = document.getElementById('user-avatar-initial');
    var menuBtn = document.getElementById('user-menu-btn');
    var dropdown = document.getElementById('user-dropdown');
    var signoutBtn = document.getElementById('btn-signout');

    if (userEmail) {
      if (navSignIn) navSignIn.hidden = true;
      if (userMenu) userMenu.hidden = false;
      if (userEmailEl) userEmailEl.textContent = userEmail;
      if (userAvatarEl) userAvatarEl.textContent = userEmail.charAt(0).toUpperCase();

      if (navCreateBtn) {
        navCreateBtn.href = '/app';
        navCreateBtn.textContent = 'Go to App';
      }
      if (heroCreateBtn) {
        heroCreateBtn.href = '/app';
      }

      // Re-point any in-content "Create video" / "Start free" buttons from /signin to /app
      var allSigninLinks = document.querySelectorAll('a[href="/signin"]');
      allSigninLinks.forEach(function (link) {
        if (link.id !== 'navSignIn' && !link.classList.contains('btn-nav-outline') && !link.classList.contains('btn-nav-solid')) {
          link.href = '/app';
          if (link.getAttribute('data-plan-cta') === 'pro') {
            link.textContent = 'Upgrade in App';
          }
        }
      });

      // Wire up menu open/close
      if (menuBtn && dropdown && !menuBtn._bound) {
        menuBtn._bound = true;
        menuBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var open = dropdown.classList.toggle('open');
          menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        document.addEventListener('click', function () {
          if (dropdown.classList.contains('open')) {
            dropdown.classList.remove('open');
            menuBtn.setAttribute('aria-expanded', 'false');
          }
        });

        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && dropdown.classList.contains('open')) {
            dropdown.classList.remove('open');
            menuBtn.setAttribute('aria-expanded', 'false');
            menuBtn.focus();
          }
        });
      }

      // Wire up sign out
      if (signoutBtn && !signoutBtn._bound) {
        signoutBtn._bound = true;
        signoutBtn.addEventListener('click', async function () {
          try {
            await fetch(API_BASE + '/api/auth/logout', { method: 'POST', credentials: 'include' });
          } catch (_) {}
          localStorage.removeItem('userEmail');
          localStorage.removeItem('firebaseToken');
          window.location.href = '/signin';
        });
      }
    } else {
      if (navSignIn) navSignIn.hidden = false;
      if (userMenu) userMenu.hidden = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNavAuth);
  } else {
    initNavAuth();
  }
})();
