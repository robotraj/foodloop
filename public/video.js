// 20-second "how it works" promo (media/foodloop-promo.mp4, made from media/promo.html).
// The site's own controls drive a muted <video>: big play button, scrubber, clock and captions
// that describe each scene, since the video has no sound.
(function () {
  const HOLD_AT_END = 2; // seconds to rest on the last frame before looping
  const captions = [
    [0, "Just before closing, a restaurant still has good food left"],
    [3.6, "FoodLoop sends one message. The restaurant just replies."],
    [7.6, "The router picks the best next life for every item"],
    [11.6, "Neighbours nearby get an alert and pick it up"],
    [15.4, "Even the peels come back as food"],
    [18.4, "Every surplus portion finds its best next life"],
  ];

  const player = document.getElementById("player");
  if (!player) return;
  const video = document.getElementById("promo");
  const scrub = document.getElementById("scrub");
  const clock = document.getElementById("clock");
  const caption = document.getElementById("caption");
  const playBtn = document.getElementById("playBtn");
  const bigPlay = document.getElementById("bigPlay");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const duration = () => (Number.isFinite(video.duration) ? video.duration : 20);
  const fmt = (s) => `0:${String(Math.floor(s)).padStart(2, "0")}`;

  function render() {
    const t = video.currentTime;
    const text = (captions.findLast(([at]) => t >= at) ?? captions[0])[1];
    if (caption.textContent !== text) caption.textContent = text;
    scrub.max = String(Math.round(duration() * 1000));
    scrub.value = String(Math.round(t * 1000));
    scrub.style.setProperty("--progress", `${(t / duration()) * 100}%`);
    clock.textContent = `${fmt(Math.min(t, duration()))} / ${fmt(duration())}`;
  }

  function setState() {
    const playing = !video.paused;
    player.classList.toggle("playing", playing);
    player.classList.toggle("ended", video.ended && !playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : video.ended ? "Replay" : "Play");
  }

  // ---- Playback ----
  let userPaused = false;
  let restTimer;

  const play = () => {
    clearTimeout(restTimer);
    if (video.ended) video.currentTime = 0;
    video.play().catch(() => {}); // autoplay can be refused; the big play button stays visible
  };
  const pause = () => video.pause();

  function toggle() {
    if (video.paused) {
      userPaused = false;
      play();
    } else {
      userPaused = true;
      pause();
    }
  }

  // Rest on the end card, then loop while it is on screen.
  video.addEventListener("ended", () => {
    setState();
    restTimer = setTimeout(() => {
      if (!userPaused && onScreen) {
        video.currentTime = 0;
        play();
      }
    }, HOLD_AT_END * 1000);
  });
  for (const ev of ["play", "pause", "seeked"]) video.addEventListener(ev, setState);
  for (const ev of ["timeupdate", "loadedmetadata", "seeked"]) video.addEventListener(ev, render);
  // timeupdate fires only ~4×/s; keep the scrubber smooth while playing.
  (function tick() {
    if (!video.paused) render();
    requestAnimationFrame(tick);
  })();

  playBtn.addEventListener("click", toggle);
  bigPlay.addEventListener("click", toggle);
  video.parentElement.addEventListener("click", toggle);
  player.addEventListener("keydown", (e) => {
    if (e.target === scrub) return;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    }
  });

  let wasPlaying = false;
  scrub.addEventListener("pointerdown", () => {
    wasPlaying = !video.paused;
    pause();
  });
  scrub.addEventListener("input", () => {
    video.currentTime = Number(scrub.value) / 1000;
    render();
  });
  scrub.addEventListener("change", () => {
    if (wasPlaying) play();
  });

  // Autoplay while on screen (unless the visitor paused it or prefers reduced motion).
  let onScreen = false;
  new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen && !userPaused && !reducedMotion) play();
      else if (!onScreen) pause();
    },
    { threshold: 0.5 },
  ).observe(player);

  render();
  setState();
})();
