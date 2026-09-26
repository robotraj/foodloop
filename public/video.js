// 10-second "how it works" explainer. Every frame is a pure function of the time t, so it can be
// played, paused and scrubbed like a real video. Elements declare their timing in the markup:
//   data-in="2.5" data-out="4.9" data-fx="pop|fade|fade-up|slide-left|grow|ping" [data-dur="0.9"]
(function () {
  const DURATION = 10;
  const HOLD_AT_END = 2; // seconds to rest on the last frame before looping
  const FLOWER_AT = 8.2;
  const captions = [
    [0, "7:45 pm — a restaurant has 8 portions left over"],
    [2.5, "Our agent asks; the restaurant just replies"],
    [5, "Everyone within walking distance gets an alert"],
    [7.5, "Pick it up at a fair price. Food saved."],
  ];

  const player = document.getElementById("player");
  if (!player) return;
  const stage = document.getElementById("stage");
  const scrub = document.getElementById("scrub");
  const clock = document.getElementById("clock");
  const caption = document.getElementById("caption");
  const playBtn = document.getElementById("playBtn");
  const bigPlay = document.getElementById("bigPlay");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flower = Sunflower.create({ stem: true });
  document.getElementById("videoFlower").append(flower);
  let flowerOpen = false;

  const tracks = [...stage.querySelectorAll("[data-in]")].map((node) => ({
    node,
    in: Number(node.dataset.in),
    out: node.dataset.out ? Number(node.dataset.out) : Infinity,
    fx: node.dataset.fx || "fade",
    dur: Number(node.dataset.dur || 0.45),
  }));

  const clamp = (x) => Math.min(1, Math.max(0, x));
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const easeBack = (x) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

  function style(fx, p) {
    switch (fx) {
      case "fade-up": return `translateY(${(1 - easeOut(p)) * 16}px)`;
      case "pop": return `scale(${0.6 + 0.4 * easeBack(p)})`;
      case "slide-left": return `translateX(${(1 - easeOut(p)) * 80}px)`;
      case "grow": return `scale(${easeOut(p)})`;
      case "ping": return `scale(${0.4 + 0.6 * easeBack(p)})`;
      default: return "";
    }
  }

  function render(t) {
    for (const tr of tracks) {
      const p = clamp((t - tr.in) / tr.dur);
      const q = clamp((t - tr.out) / 0.3);
      tr.node.style.opacity = String(p * (1 - q));
      tr.node.style.transform = style(tr.fx, p);
      tr.node.classList.toggle("on", t >= tr.in + tr.dur && t < tr.out);
    }
    if (t >= FLOWER_AT && !flowerOpen) Sunflower.bloom(flower);
    if (t < FLOWER_AT && flowerOpen) Sunflower.reset(flower);
    flowerOpen = t >= FLOWER_AT;

    const text = (captions.findLast(([at]) => t >= at) ?? captions[0])[1];
    if (caption.textContent !== text) caption.textContent = text;
    scrub.value = String(Math.round(t * 1000));
    scrub.style.setProperty("--progress", `${(t / DURATION) * 100}%`);
    clock.textContent = `0:${String(Math.floor(Math.min(t, DURATION))).padStart(2, "0")} / 0:10`;
  }

  // ---- Playback ----
  let t = 0;
  let playing = false;
  let userPaused = false;
  let last = 0;
  let endedAt = null;

  function setState() {
    const ended = t >= DURATION;
    player.classList.toggle("playing", playing);
    player.classList.toggle("ended", ended && !playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : ended ? "Replay" : "Play");
  }

  function frame(now) {
    if (!playing) return;
    // rAF timestamps can be slightly earlier than the performance.now() taken in play().
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (t < DURATION) {
      t = Math.min(DURATION, t + dt);
      render(t);
    } else {
      endedAt ??= now;
      if (now - endedAt > HOLD_AT_END * 1000) {
        t = 0;
        endedAt = null;
        render(t);
      }
    }
    requestAnimationFrame(frame);
  }

  function play() {
    if (playing) return;
    if (t >= DURATION) t = 0;
    playing = true;
    endedAt = null;
    last = performance.now();
    setState();
    requestAnimationFrame(frame);
  }

  function pause() {
    playing = false;
    setState();
  }

  function toggle() {
    if (playing) {
      userPaused = true;
      pause();
    } else {
      userPaused = false;
      play();
    }
  }

  playBtn.addEventListener("click", toggle);
  bigPlay.addEventListener("click", toggle);
  stage.parentElement.addEventListener("click", toggle);
  player.addEventListener("keydown", (e) => {
    if (e.target === scrub) return;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    }
  });

  let wasPlaying = false;
  scrub.addEventListener("pointerdown", () => {
    wasPlaying = playing;
    pause();
  });
  scrub.addEventListener("input", () => {
    t = Number(scrub.value) / 1000;
    render(t);
    setState();
  });
  scrub.addEventListener("change", () => {
    if (wasPlaying) play();
  });

  // Scale the fixed 640×400 stage to the player's width.
  new ResizeObserver(([entry]) => {
    stage.style.setProperty("--scale", String(entry.contentRect.width / 640));
  }).observe(stage.parentElement);

  // Autoplay while on screen (unless the visitor paused it or prefers reduced motion).
  new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && !userPaused && !reducedMotion) play();
      else if (!entry.isIntersecting) pause();
    },
    { threshold: 0.5 },
  ).observe(player);

  render(t);
  setState();
})();
