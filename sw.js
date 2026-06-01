self.addEventListener('install', () => {
    console.log('SW: install');
    self.skipWaiting();
});

self.addEventListener('activate', () => {
    console.log('SW: activate');
    clients.claim();
});

self.addEventListener('push', (event) => {
    console.log('SW: push получен');

    let title = 'Напоминание';
    let body = 'Не забудьте!';
    let reminderId = null;

    if (event.data) {
        try {
            const data = event.data.json();
            title = data.title || title;
            body = data.body || body;
            reminderId = data.reminderId;
        } catch (e) {
            body = event.data.text();
        }
    }

    const options = {
        body: body,
        icon: '/icons/favicon-256x256.png',
        badge: '/icons/favicon-256x256.png',
        vibrate: [200, 100, 200],
        requireInteraction: true,
        data: { reminderId: reminderId },
        silent: false
    };

    if (reminderId) {
        options.actions = [
            { action: 'snooze', title: 'Отложить на 5 минут' }
        ];
    }

    event.waitUntil(
        self.registration.showNotification(title, options).then(() => {
            console.log('SW: уведомление показано');
        }).catch(err => {
            console.error('SW: ошибка показа уведомления', err);
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    console.log('SW: клик по уведомлению', event.action);
    const notification = event.notification;
    const action = event.action;

    if (action === 'snooze') {
        const reminderId = notification.data.reminderId;
        console.log('SW: отложить напоминание', reminderId);
        event.waitUntil(
            fetch(`/snooze?reminderId=${reminderId}`, { method: 'POST' })
                .then(() => {
                    console.log('SW: напоминание отложено');
                    notification.close();
                })
                .catch(err => console.error('SW: ошибка откладывания', err))
        );
    } else {
        notification.close();
        event.waitUntil(
            clients.matchAll({ type: 'window' }).then(clientList => {
                for (const client of clientList) {
                    if (client.url.includes('/') && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow('/');
                }
            })
        );
    }
});