// Mobile navigation for the calendar page.
//
// The shared stylesheet hides .nav-links below 768px and the built page ships
// no toggle, so on a phone the top navigation was unreachable and the footer
// was the only way out. This adds the control. It is an external module, and
// the styles are in amu-calendar.css, because the module serving this page
// sends script-src 'self' and style-src 'self': anything inline is blocked.
(function () {
  "use strict";
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("cal-nav");
  if (!toggle || !nav) return;
  var bar = toggle.closest("nav");

  function isOpen() {
    return toggle.getAttribute("aria-expanded") === "true";
  }

  function setOpen(open) {
    nav.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    setOpen(false);
    if (returnFocus) toggle.focus();
  }

  toggle.addEventListener("click", function () {
    setOpen(!isOpen());
  });

  // Escape closes and hands focus back to the control that opened it.
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" || event.key === "Esc") close(true);
  });

  // A tap outside the bar closes it; a link inside navigates, so close too.
  document.addEventListener("click", function (event) {
    if (!isOpen()) return;
    if (bar && !bar.contains(event.target)) close(false);
  });
  nav.addEventListener("click", function (event) {
    if (event.target.closest("a")) close(false);
  });

  // Above the breakpoint the links are visible on their own: leaving the menu
  // marked open would report an expanded state that no longer means anything.
  var wide = window.matchMedia("(min-width: 769px)");
  var onWide = function (event) {
    if (event.matches) close(false);
  };
  if (wide.addEventListener) wide.addEventListener("change", onWide);
  else if (wide.addListener) wide.addListener(onWide);
})();
