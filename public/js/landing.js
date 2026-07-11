(() => {
  const newMeetingBtn = document.getElementById('newMeetingBtn');
  const joinForm = document.getElementById('joinForm');
  const joinInput = document.getElementById('joinInput');
  const joinBtn = document.getElementById('joinBtn');
  const landingError = document.getElementById('landingError');
  const recentRooms = document.getElementById('recentRooms');
  const recentList = document.getElementById('recentList');

  const ROOM_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

  function showError(msg) {
    landingError.textContent = msg;
    landingError.hidden = false;
  }

  const params = new URLSearchParams(location.search);
  if (params.get('error') === 'invalid-room') {
    showError('That meeting link is not valid. Check the code and try again.');
  } else if (params.get('removed') === '1') {
    showError('You were removed from the meeting by the host.');
  } else if (params.get('left') === '1') {
    showError('You left the meeting.');
    landingError.style.color = 'var(--text-dim)';
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

  newMeetingBtn.addEventListener('click', async () => {
    newMeetingBtn.disabled = true;
    try {
      const res = await fetch('/api/new-room');
      const { roomId } = await res.json();
      location.href = `/room/${roomId}`;
    } catch {
      showError('Could not create a meeting. Is the server running?');
      newMeetingBtn.disabled = false;
    }
  });

  // Recent meetings (stored by room.js on join)
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
})();
