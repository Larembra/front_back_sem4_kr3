const contentDiv = document.getElementById('app-content');
const homeBtn = document.getElementById('home-btn');
const aboutBtn = document.getElementById('about-btn');

const socket = io();
const VAPID_PUBLIC_KEY = 'BG_mvqULlWO1eUaikilybUP9aRMlUQONojEX4b1AlYnpzkI60W2KcGdXei8Et2JsBB6rh8C_sleTLXpQT3EgiO0';

function setActiveButton(activeId) {
    [homeBtn, aboutBtn].forEach(btn => btn.classList.remove('active'));
    document.getElementById(activeId).classList.add('active');
}

async function loadContent(page) {
    try {
        const response = await fetch(`content/${page}.html`);
        const html = await response.text();
        contentDiv.innerHTML = html;
        if (page === 'home') initNotes();
    } catch (err) {
        contentDiv.innerHTML = '<p class="is-center text-error">Ошибка загрузки страницы.</p>';
        console.error('Ошибка загрузки контента:', err);
    }
}

homeBtn.addEventListener('click', () => {
    setActiveButton('home-btn');
    loadContent('home');
});

aboutBtn.addEventListener('click', () => {
    setActiveButton('about-btn');
    loadContent('about');
});

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert('Service Worker или Push не поддерживаются');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            alert('Необходимо разрешить уведомления');
            return;
        }

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });

        const response = await fetch('/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
        });

        if (response.ok) {
            console.log('Подписка на push отправлена');
            alert('Уведомления включены!');
        } else {
            alert('Ошибка подписки на сервере');
        }
    } catch (err) {
        console.error('Ошибка подписки:', err);
        alert('Ошибка: ' + err.message);
    }
}

async function unsubscribeFromPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            await fetch('/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            await subscription.unsubscribe();
            console.log('Отписка выполнена');
            alert('Уведомления отключены');
        }
    } catch (err) {
        console.error('Ошибка отписки:', err);
    }
}

function initNotes() {
    const form = document.getElementById('note-form');
    const input = document.getElementById('note-input');
    const reminderTime = document.getElementById('reminder-time');
    const list = document.getElementById('notes-list');

    function loadNotes() {
        const notes = JSON.parse(localStorage.getItem('notes') || '[]');
        list.innerHTML = notes.map(note => {
            let reminderInfo = '';
            if (note.reminder) {
                const date = new Date(note.reminder);
                reminderInfo = `<br><small style="color: #666;">⏰ Напоминание: ${date.toLocaleString()}</small>`;
            }
            return `<li class="card" style="margin-bottom: 1rem;">${note.text}${reminderInfo}</li>`;
        }).join('');
    }

    function addNote(text, reminderTimeValue = null) {
        const notes = JSON.parse(localStorage.getItem('notes') || '[]');
        const newNote = {
            id: Date.now(),
            text: text,
            reminder: reminderTimeValue ? new Date(reminderTimeValue).getTime() : null
        };
        notes.push(newNote);
        localStorage.setItem('notes', JSON.stringify(notes));
        loadNotes();

        console.log('Добавлена заметка:', text);
        socket.emit('newNote', { text: text });

        if (reminderTimeValue) {
            console.log('Отправка напоминания на сервер:', {
                id: newNote.id,
                text: text,
                reminderTime: newNote.reminder,
                reminderDate: new Date(newNote.reminder).toLocaleString()
            });
            socket.emit('newReminder', {
                id: newNote.id,
                text: text,
                reminderTime: newNote.reminder
            });
        }
    }

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            const time = reminderTime.value;

            if (text) {
                addNote(text, time || null);
                input.value = '';
                reminderTime.value = '';
            }
        });
    }

    loadNotes();
}

socket.on('noteAdded', (note) => {
    console.log('Заметка от другого клиента:', note);
    const notification = document.createElement('div');
    notification.textContent = `Новая заметка: ${note.text}`;
    notification.style.cssText = `
        position: fixed; top: 10px; right: 10px;
        background: #4285f4; color: white; padding: 1rem;
        border-radius: 5px; z-index: 1000;
    `;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            const reg = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker зарегистрирован');

            const enableBtn = document.getElementById('enable-push');
            const disableBtn = document.getElementById('disable-push');

            if (enableBtn && disableBtn) {
                const subscription = await reg.pushManager.getSubscription();
                if (subscription) {
                    enableBtn.style.display = 'none';
                    disableBtn.style.display = 'inline-block';
                    console.log('Уже подписаны');
                } else {
                    enableBtn.style.display = 'inline-block';
                    disableBtn.style.display = 'none';
                    console.log('Не подписаны');
                }

                enableBtn.addEventListener('click', async () => {
                    await subscribeToPush();
                    const sub = await reg.pushManager.getSubscription();
                    if (sub) {
                        enableBtn.style.display = 'none';
                        disableBtn.style.display = 'inline-block';
                    }
                });

                disableBtn.addEventListener('click', async () => {
                    await unsubscribeFromPush();
                    const sub = await reg.pushManager.getSubscription();
                    if (!sub) {
                        disableBtn.style.display = 'none';
                        enableBtn.style.display = 'inline-block';
                    }
                });
            }
        } catch (err) {
            console.error('Ошибка регистрации SW:', err);
        }
    });
}

loadContent('home');