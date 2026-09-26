// Sunflower illustration that blooms: the stem grows, leaves unfold, petals twist open and the
// seeds fill in along a golden-angle spiral. Usage:
//   const svg = Sunflower.create({ stem: true }); container.append(svg); Sunflower.bloom(svg);
// Or declaratively: <div data-sunflower data-stem></div> blooms when scrolled into view.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const GOLDEN_ANGLE = 137.508;
  let uid = 0;

  function el(tag, attrs = {}, style = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const [k, v] of Object.entries(style)) node.style.setProperty(k, v);
    return node;
  }

  function create({ stem = false, petals = 21, seeds = 150, delay = 0 } = {}) {
    const id = `sf${uid++}`;
    const svg = el("svg", {
      viewBox: stem ? "-112 -112 224 372" : "-112 -112 224 224",
      class: "sunflower",
      role: "img",
      "aria-hidden": "true",
    });
    const t = (s) => `${(delay + s).toFixed(3)}s`;

    const defs = el("defs");
    defs.innerHTML = `
      <linearGradient id="${id}-petal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffd84a"/><stop offset="1" stop-color="#f2a516"/>
      </linearGradient>
      <linearGradient id="${id}-inner" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f7b82a"/><stop offset="1" stop-color="#d9860f"/>
      </linearGradient>
      <radialGradient id="${id}-disc"><stop offset="0" stop-color="#6b4219"/><stop offset="1" stop-color="#3d250d"/></radialGradient>`;
    svg.append(defs);

    if (stem) {
      svg.append(
        el("path", { class: "sf-stem", d: "M0 30 C 10 100, -10 170, 0 258", pathLength: 1 }, { "--d": t(0) }),
        el("path", { class: "sf-leaf", d: "M0 0 C 18 -30, 58 -34, 84 -12 C 58 6, 26 12, 0 0 Z" }, { "--tx": "2px", "--ty": "150px", "--r": "-8deg", "--d": t(0.45) }),
        el("path", { class: "sf-leaf", d: "M0 0 C -18 -26, -54 -30, -76 -10 C -52 6, -22 10, 0 0 Z" }, { "--tx": "-2px", "--ty": "196px", "--r": "6deg", "--d": t(0.6) }),
      );
    }

    // Outer petals, then a shorter offset inner ring.
    for (let i = 0; i < petals; i++) {
      svg.append(
        el("path", { class: "sf-petal", d: "M0 -26 C 15 -44, 15 -88, 0 -104 C -15 -88, -15 -44, 0 -26 Z", fill: `url(#${id}-petal)` },
          { "--a": `${(360 / petals) * i}deg`, "--d": t(0.75 + i * 0.035) }),
      );
    }
    for (let i = 0; i < petals; i++) {
      svg.append(
        el("path", { class: "sf-petal", d: "M0 -24 C 11 -38, 11 -66, 0 -78 C -11 -66, -11 -38, 0 -24 Z", fill: `url(#${id}-inner)` },
          { "--a": `${(360 / petals) * (i + 0.5)}deg`, "--d": t(0.95 + i * 0.03) }),
      );
    }

    svg.append(el("circle", { class: "sf-disc", r: 36, fill: `url(#${id}-disc)` }, { "--d": t(0.6) }));
    for (let i = 1; i <= seeds; i++) {
      const r = 2.75 * Math.sqrt(i);
      const a = (i * GOLDEN_ANGLE * Math.PI) / 180;
      svg.append(
        el("circle", {
          class: "sf-seed",
          cx: (r * Math.cos(a)).toFixed(2),
          cy: (r * Math.sin(a)).toFixed(2),
          r: (1.3 + i / seeds).toFixed(2),
          fill: i % 3 ? "#2b1808" : "#9a6a2f",
        }, { "--d": t(1.1 + i * 0.008) }),
      );
    }
    return svg;
  }

  /** (Re)start the bloom animation. */
  function bloom(svg) {
    svg.classList.remove("bloom");
    void svg.getBoundingClientRect(); // restart CSS animations
    svg.classList.add("bloom");
  }

  function reset(svg) {
    svg.classList.remove("bloom");
  }

  // Declarative sunflowers bloom the first time they scroll into view.
  function autoBloom() {
    const nodes = document.querySelectorAll("[data-sunflower]");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          bloom(entry.target.querySelector("svg"));
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.4 },
    );
    nodes.forEach((node) => {
      node.append(create({ stem: node.hasAttribute("data-stem"), delay: Number(node.dataset.delay || 0) }));
      observer.observe(node);
    });
  }

  window.Sunflower = { create, bloom, reset, autoBloom };
})();
