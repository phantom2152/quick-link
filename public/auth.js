(() => {
    let pending = null;

    // One dialog at a time, even if several requests 401 together
    function ensureLogin() {
        if (!pending) pending = showLoginDialog().finally(() => { pending = null; });
        return pending;
    }

    function mk(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function showLoginDialog() {
        return new Promise((resolve) => {
            const dialog = mk('dialog', 'm-auto w-full max-w-xs p-5 bg-zinc-900 text-zinc-100 border border-zinc-800 rounded font-mono backdrop:bg-black/70');
            const form = mk('form', 'flex flex-col gap-3');

            const title = mk('div', 'text-sm font-medium', 'Password required');

            const input = mk('input', 'px-3 py-2 bg-zinc-950 border border-zinc-800 rounded text-sm outline-none focus:border-zinc-600');
            input.type = 'password';
            input.placeholder = 'password';
            input.autocomplete = 'current-password';
            input.required = true;

            const err = mk('div', 'text-xs text-red-400 h-4');

            const row = mk('div', 'flex gap-2 justify-end');
            const cancel = mk('button', 'px-3 py-1.5 border border-zinc-800 rounded text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors', 'cancel');
            cancel.type = 'button';
            const submit = mk('button', 'px-3 py-1.5 bg-zinc-100 text-zinc-900 rounded text-xs font-medium hover:bg-white transition-colors disabled:opacity-30', 'unlock');
            submit.type = 'submit';

            row.append(cancel, submit);
            form.append(title, input, err, row);
            dialog.append(form);

            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                dialog.close();
                dialog.remove();
                resolve(ok);
            };

            cancel.addEventListener('click', () => finish(false));
            dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Esc

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                submit.disabled = true;
                err.textContent = '';
                try {
                    const res = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: input.value }),
                    });
                    if (res.ok) return finish(true);
                    err.textContent =
                        res.status === 401 ? 'Wrong password' :
                            res.status === 429 ? 'Too many attempts, wait a minute' :
                                'Login failed';
                    input.value = '';
                    input.focus();
                } catch {
                    err.textContent = 'Network error';
                } finally {
                    submit.disabled = false;
                }
            });

            document.body.append(dialog);
            dialog.showModal();
            input.focus();
        });
    }

    // Drop-in replacement for fetch on protected endpoints.
    // On 401: ask for the password, then replay the request once.
    // If the user cancels, they get the original 401 response back.
    window.api = async function api(url, options) {
        const res = await fetch(url, options);
        if (res.status !== 401) return res;
        const ok = await ensureLogin();
        return ok ? fetch(url, options) : res;
    };

    window.logout = async function logout() {
        await fetch('/api/logout', { method: 'POST' });
        location.reload();
    };
})();