(function () {
  'use strict';

  function initNavAuth() {
    var API_BASE = (window.__API_BASE__ || '').replace(/\/$/, '');
    var cachedEmail = localStorage.getItem('userEmail');

    var navSignIn = document.getElementById('navSignIn');
    var navCreateBtn = document.getElementById('navCreateBtn');
    var heroCreateBtn = document.getElementById('heroCreateBtn');
    var userMenu = document.getElementById('userMenu');
    var userEmailEl = document.getElementById('user-dropdown-email');
    var userAvatarEl = document.getElementById('user-avatar-initial');
    var menuBtn = document.getElementById('user-menu-btn');
    var dropdown = document.getElementById('user-dropdown');
    var signoutBtn = document.getElementById('btn-signout');
    var drawerAppBtn = document.getElementById('drawerAppBtn');
    var drawerSignInBtn = document.getElementById('drawerSignInBtn');

    function setLoggedInState(email) {
      if (navSignIn) navSignIn.hidden = true;
      if (userMenu) userMenu.hidden = false;
      if (drawerAppBtn) drawerAppBtn.style.display = 'block';
      if (drawerSignInBtn) drawerSignInBtn.style.display = 'none';
      if (userEmailEl) userEmailEl.textContent = email;
      if (userAvatarEl) userAvatarEl.textContent = email.charAt(0).toUpperCase();

      if (navCreateBtn) {
        navCreateBtn.href = '/app';
        navCreateBtn.textContent = 'Go to App';
      }
      if (heroCreateBtn) {
        heroCreateBtn.href = '/app';
      }

      var allSigninLinks = document.querySelectorAll('a[href="/signin"]');
      allSigninLinks.forEach(function (link) {
        if (link.id !== 'navSignIn' && link.id !== 'drawerSignInBtn' && !link.classList.contains('btn-nav-outline') && !link.classList.contains('btn-nav-solid')) {
          link.href = '/app';
          if (link.getAttribute('data-plan-cta') === 'pro') {
            link.textContent = 'Upgrade in App';
          }
        }
      });
    }

    function setLoggedOutState() {
      if (navSignIn) navSignIn.hidden = false;
      if (userMenu) userMenu.hidden = true;
      if (drawerAppBtn) drawerAppBtn.style.display = 'none';
      if (drawerSignInBtn) drawerSignInBtn.style.display = 'block';
      if (navCreateBtn) {
        navCreateBtn.href = '/signin';
        navCreateBtn.textContent = 'Create Video';
      }
      if (heroCreateBtn) {
        heroCreateBtn.href = '/signin';
      }
    }

    // 1. Instant paint from cache if available
    if (cachedEmail) {
      setLoggedInState(cachedEmail);
    } else {
      setLoggedOutState();
    }

    // 2. Validate/refresh session with server
    fetch(API_BASE + '/api/me', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && (data.email || data.uid)) {
          var email = data.email || cachedEmail || 'user';
          localStorage.setItem('userEmail', email);
          setLoggedInState(email);
        } else if (!cachedEmail) {
          setLoggedOutState();
        }
      })
      .catch(function () {});

    // Wire up account dropdown menu open/close
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

    // Wire up mobile nav toggle
    var navToggle = document.getElementById('nav-toggle');
    var navLinks = document.getElementById('nav-links');
    if (navToggle && navLinks && !navToggle._bound) {
      navToggle._bound = true;
      var setNavOpen = function (open) {
        navLinks.classList.toggle('open', open);
        navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      };

      navToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setNavOpen(!navLinks.classList.contains('open'));
      });

      navLinks.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') setNavOpen(false);
      });

      document.addEventListener('click', function (e) {
        if (!navLinks.contains(e.target) && !navToggle.contains(e.target)) {
          setNavOpen(false);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNavAuth);
  } else {
    initNavAuth();
  }
})();
