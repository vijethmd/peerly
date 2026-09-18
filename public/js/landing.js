(() => {
  const newMeetingButtons = document.querySelectorAll('[data-new-meeting]');
  const joinForm = document.getElementById('joinForm');
  const joinInput = document.getElementById('joinInput');
  const joinBtn = document.getElementById('joinBtn');
  const landingError = document.getElementById('landingError');
  const recentRooms = document.getElementById('recentRooms');
  const recentList = document.getElementById('recentList');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ROOM_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

  function showError(msg, { info = false } = {}) {
    landingError.textContent = msg;
    landingError.classList.toggle('is-info', info);
    landingError.hidden = false;
  }

  const params = new URLSearchParams(location.search);
  if (params.get('error') === 'invalid-room') {
    showError('That meeting link is not valid. Check the code and try again.');
  } else if (params.get('removed') === '1') {
    showError('You were removed from the meeting by the host.');
  } else if (params.get('left') === '1') {
    showError('You left the meeting.', { info: true });
  }
  if (params.toString()) {
    history.replaceState(null, '', '/');
  }

  // Extract a room code from raw text: accepts "abc-defg-hij" or any URL containing /room/<code>.
  function parseRoomId(raw) {
    const text = raw.trim().toLowerCase();
    if (ROOM_ID_RE.test(text)) return text;
    const match = text.match(/room\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : null;
  }

  joinInput.addEventListener('input', () => {
    joinBtn.disabled = !parseRoomId(joinInput.value);
    landingError.hidden = true;
  });

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const roomId = parseRoomId(joinInput.value);
    if (!roomId) {
      showError('Enter a valid meeting code like abc-defg-hij or paste the full link.');
      return;
    }
    location.href = `/room/${roomId}`;
  });

  async function startMeeting() {
    newMeetingButtons.forEach((button) => { button.disabled = true; });
    try {
      const res = await fetch('/api/new-room');
      const { roomId } = res.ok ? await res.json() : {};
      if (!roomId) throw new Error(`HTTP ${res.status}`);
      location.href = `/room/${roomId}`;
    } catch {
      showError('Could not create a meeting. Check your connection and try again.');
      landingError.scrollIntoView({ block: 'center' });
      newMeetingButtons.forEach((button) => { button.disabled = false; });
    }
  }
  newMeetingButtons.forEach((button) => button.addEventListener('click', startMeeting));

  // Recent meetings (stored by the room page on join)
  try {
    const recent = JSON.parse(localStorage.getItem('peerly-recent') || '[]');
    if (Array.isArray(recent) && recent.length > 0) {
      recentRooms.hidden = false;
      recent.slice(0, 5).forEach(({ roomId }) => {
        if (!ROOM_ID_RE.test(roomId)) return;
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `/room/${roomId}`;
        a.textContent = roomId;
        li.appendChild(a);
        recentList.appendChild(li);
      });
    }
  } catch { /* ignore corrupt storage */ }

  // Sections fade up as they scroll into view. Anything already on screen is
  // shown straight away so nothing flickers out and back in.
  const reveals = document.querySelectorAll('.reveal');
  if (!reduceMotion && 'IntersectionObserver' in window && reveals.length) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
    document.documentElement.classList.add('js-reveal');
    for (const el of reveals) {
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-visible');
      else observer.observe(el);
    }
  }

  // Headline typewriter: deletes the word and types the next one.
  const typewriter = document.getElementById('typewriter');
  const caret = typewriter && typewriter.nextElementSibling;
  const WORDS = ['everyone', 'your team', 'stand-ups', 'your class', 'interviews', 'family'];
  if (typewriter && !reduceMotion) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let index = 0;
    (async () => {
      await wait(2600);
      for (;;) {
        const word = WORDS[index];
        caret.classList.add('is-typing');
        for (let n = word.length - 1; n >= 0; n--) {
          typewriter.textContent = word.slice(0, n);
          await wait(36);
        }
        index = (index + 1) % WORDS.length;
        const next = WORDS[index];
        await wait(220);
        for (let n = 1; n <= next.length; n++) {
          typewriter.textContent = next.slice(0, n);
          await wait(65 + Math.random() * 55);
        }
        caret.classList.remove('is-typing');
        await wait(2400);
      }
    })();
  }
})();
