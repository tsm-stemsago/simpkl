/* =====================================================================
   face-attendance.js  -  SIM PKL SMK Negeri 1 Gombong
   Presensi wajah di browser (@vladmandic/face-api), kamera depan langsung.

   Bergantung pada variabel global milik index.html (dipanggil saat dipakai,
   bukan saat dimuat): sbClient, q, B, friendlyError, window.app.
   Gaya tampilan modul ini mandiri (awalan .fa-), tidak memakai Tailwind,
   jadi tidak perlu mengubah tailwind.config.js.
   ===================================================================== */
(function () {
    'use strict';

    /* ================= 1. KONFIGURASI ================= */
    const CFG = {
        ENABLED: true,
        APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwEniW0Q2oPdMrLpPzu2L55t44y8HXcIgClsdZtGkguKKdIgwrNZvssq2VjMSWrus_-/exec',
        // Samakan dengan Script Property SECRET_TOKEN di Apps Script (token ini terlihat di front-end; keamanan sebenarnya ada pada pemeriksaan jwt Supabase di Code.gs)
        GAS_TOKEN: 'xgbwdECViH16W893FVDTBsN-gA1AUbff0nTerMTrlcQ',
        LIB_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js',
        MODEL_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/',
        LOAD_TIMEOUT_MS: 8000,        // batas tunggu pustaka + model, lewat dari ini masuk mode cadangan
        T_VERIFIED: 0.45,             // jarak < 0.45  -> VERIFIED (sama dengan presensi_catat_wajah)
        T_REJECT: 0.60,               // 0.45 < jarak <= 0.60 -> PENDING_REVIEW; di atasnya ditolak
        MAX_FAIL: 3,                  // setelah 3 kali tidak cocok, siswa boleh mengirim untuk ditinjau guru
        ENROLL_SAMPLES: 3,            // contoh wajah saat pendaftaran; dirata-rata menjadi satu descriptor
        VERIFY_SAMPLES: 2,            // jumlah contoh wajah saat presensi
        LIVENESS_TIMEOUT_MS: 15000,
        IMG_MAX: 480,                 // sisi terpanjang foto (px)
        JPEG_Q: 0.6,
        UPLOAD_TIMEOUT_MS: 30000,
        // Teks persetujuan. Mohon sekolah memeriksa dan menyesuaikan redaksinya.
        CONSENT_HTML:
            '<p>Dengan melanjutkan, saya menyetujui pemrosesan <b>data wajah</b> saya untuk keperluan presensi Praktik Kerja Lapangan (PKL) di SIM PKL SMK Negeri 1 Gombong.</p>' +
            '<ul><li>Yang disimpan: representasi numerik wajah (bukan foto) di basis data sekolah, dan satu foto setiap presensi di Google Drive sekolah.</li>' +
            '<li>Data hanya dipakai untuk presensi dan dapat dilihat oleh guru pembimbing, pokja PKL, dan admin sekolah.</li>' +
            '<li>Pendaftaran wajah hanya dapat diulang melalui guru pembimbing atau Pokja PKL.</li></ul>'
    };

    /* ================= 2. KONTRAK DATABASE (migrasi 13) DAN APPS SCRIPT (Code.gs) ================= */
    const msgOf = (e) => (typeof friendlyError === 'function' ? friendlyError(e) : (e && e.message) || String(e));

    const API = {
        // siswa_wajah.descriptor: satu larik 128 angka; RLS membatasi ke milik siswa sendiri
        async getEnrollment(sid) {
            const { data, error } = await sbClient.from('siswa_wajah').select('descriptor').eq('siswa_id', sid).maybeSingle();
            if (error) throw new Error(msgOf(error));
            return data && Array.isArray(data.descriptor) ? [new Float32Array(data.descriptor)] : [];
        },
        async daftar(descriptor) {
            const { error } = await sbClient.rpc('daftar_wajah', { p_descriptor: descriptor, p_setuju: true });
            if (error) throw new Error(msgOf(error));
        },
        // Server menentukan status: < 0.45 VERIFIED, 0.45 sampai 0.60 PENDING_REVIEW, > 0.60 ditolak; p_model_gagal = PENDING_REVIEW
        async catat(a) {
            const { data, error } = await sbClient.rpc('presensi_catat_wajah', {
                p_jenis: a.jenis, p_lat: a.pos.latitude, p_lng: a.pos.longitude, p_akurasi: a.pos.accuracy,
                p_photo_url: a.url, p_face_distance: a.score, p_model_gagal: a.modelGagal
            });
            if (error) throw new Error(msgOf(error));
            return data;
        },
        async hariIni(sid, tanggal) {
            const { data, error } = await sbClient.from('presensi').select('jenis,verification_status,face_distance').eq('siswa_id', sid).eq('tanggal', tanggal);
            if (error) throw new Error(msgOf(error));
            return data || [];
        },
        async antrianTinjau() {
            const { data, error } = await sbClient.from('presensi')
                .select('id,siswa_id,tanggal,jenis,waktu,face_distance,photo_url')
                .eq('verification_status', 'PENDING_REVIEW').order('waktu', { ascending: true }).limit(100);
            if (error) throw new Error(msgOf(error));
            return data || [];
        },
        async tinjau(id, setuju) {
            const { error } = await sbClient.rpc('tinjau_wajah', { p_presensi: id, p_setuju: setuju });
            if (error) throw new Error(msgOf(error));
        },
        async reset(sid) {
            const { error } = await sbClient.rpc('reset_wajah', { p_siswa: sid });
            if (error) throw new Error(msgOf(error));
        }
    };

    // Unggah foto ke Drive lewat Code.gs: {token, jwt, tipe, image, nis, nama, waktu} -> {ok, url, id}
    async function uploadFoto(blob, meta) {
        if (!CFG.APPS_SCRIPT_URL || /^ISI_/.test(CFG.GAS_TOKEN)) throw new Error('Alamat atau token Apps Script belum diatur di face-attendance.js.');
        const { data: { session } } = await sbClient.auth.getSession();
        if (!session) throw new Error('Sesi berakhir. Silakan masuk kembali.');
        const body = JSON.stringify({ token: CFG.GAS_TOKEN, jwt: session.access_token, tipe: meta.tipe, image: await blobToB64(blob), nis: meta.nis, nama: meta.nama, waktu: meta.waktu });
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), CFG.UPLOAD_TIMEOUT_MS);
        try {
            const res = await fetch(CFG.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow', signal: ctl.signal });
            const j = await res.json();
            if (!j.ok) throw new Error(j.error || 'Unggah ditolak.');
            if (!/^https:\/\//i.test(j.url || '')) throw new Error('Apps Script tidak mengembalikan alamat berkas.');
            return j.url;
        } catch (e) {
            throw new Error(e.name === 'AbortError' ? 'Unggah foto terlalu lama.' : e.message);
        } finally { clearTimeout(t); }
    }
    async function uploadRetry(blob, meta) {
        try { return await uploadFoto(blob, meta); }
        catch (e1) {
            await sleep(1200);
            try { return await uploadFoto(blob, meta); }
            catch (e2) { throw new Error('Foto gagal diunggah (' + e2.message + '). Periksa koneksi lalu coba lagi.'); }
        }
    }

    /* ================= 3. UTILITAS ================= */
    const S = { model: 'idle', loadP: null, fail: 0, sid: null, nama: '', panelEl: null, enrolled: null };
    class Cancel extends Error { constructor() { super('Dibatalkan'); this.cancel = true; } }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (m, t) => { try { window.app.ui.showToast(m, t); } catch (e) { alert(m); } };
    const todayWib = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const stampWib = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\./g, ':') + ' WIB';
    const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ear = (p) => (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]));
    const yawOf = (lm) => (lm[30].x - lm[0].x) / (lm[16].x - lm[0].x);   // 0.5 = menghadap lurus
    const blobToB64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => fail(new Error('Gagal membaca foto.')); r.readAsDataURL(blob); });
    const safeName = (s) => String(s || 'siswa').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'siswa';
    const LABEL = {
        VERIFIED: ['Terverifikasi', 'ok'], PENDING_REVIEW: ['Menunggu tinjauan guru', 'warn'], REJECTED: ['Ditolak guru', 'bad']
    };

    /* ================= 4. MODEL FACE-API (pemuatan + batas 8 detik) ================= */
    function loadScript(src) {
        return new Promise((ok, fail) => {
            if (window.faceapi) return ok();
            const s = document.createElement('script');
            s.src = src; s.async = true; s.onload = ok;
            s.onerror = () => fail(new Error('Pustaka pengenalan wajah gagal diunduh.'));
            document.head.appendChild(s);
        });
    }
    async function realLoad() {
        await loadScript(CFG.LIB_URL);
        await faceapi.tf.ready();
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(CFG.MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(CFG.MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(CFG.MODEL_URL)
        ]);
    }
    function setModel(st) {
        S.model = st;
        const el = document.getElementById('fa-model');
        if (el) el.textContent = { idle: '', loading: 'Memuat model wajah…', ready: 'Model wajah siap.', failed: 'Model wajah belum termuat (mode cadangan: foto dikirim untuk ditinjau guru).' }[st] || '';
    }
    function startLoad() {
        if (S.loadP) return S.loadP;
        setModel('loading');
        S.loadP = realLoad().then(() => { setModel('ready'); }).catch((e) => { console.warn('[FACE] model gagal:', e); S.loadP = null; setModel('failed'); throw e; });
        return S.loadP;
    }
    // true bila model siap dalam 8 detik; false bila gagal atau lewat batas (model tetap dimuat di latar belakang)
    async function modelsReady() {
        if (S.model === 'ready') return true;
        const p = startLoad();
        const limit = new Promise((r) => setTimeout(() => r('timeout'), CFG.LOAD_TIMEOUT_MS));
        try { return (await Promise.race([p.then(() => 'ok'), limit])) === 'ok'; } catch (e) { return false; }
    }
    function preload() { if (CFG.ENABLED && S.model === 'idle') startLoad().catch(() => {}); }

    /* ================= 5. KAMERA ================= */
    async function startCamera(ui) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Peramban tidak mendukung kamera. Gunakan Chrome atau Safari terbaru dan buka lewat https.');
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        } catch (e) {
            const m = { NotAllowedError: 'Izin kamera ditolak. Aktifkan izin kamera untuk situs ini pada pengaturan peramban.', NotFoundError: 'Kamera tidak ditemukan pada perangkat ini.', NotReadableError: 'Kamera sedang dipakai aplikasi lain.' }[e.name];
            throw new Error(m || 'Kamera tidak dapat dibuka: ' + e.message);
        }
        if (ui.cancelled) { stream.getTracks().forEach((t) => t.stop()); throw new Cancel(); }
        ui.stream = stream;
        ui.video.srcObject = stream;
        await ui.video.play();
        for (let i = 0; i < 40 && !ui.video.videoWidth; i++) await sleep(50);
        if (!ui.video.videoWidth) throw new Error('Gambar kamera belum tersedia. Coba lagi.');
    }
    function grab(video) {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        return c;
    }

    /* ================= 6. TAMPILAN KAMERA ================= */
    const CSS = `
    .fa-ov{position:fixed;inset:0;z-index:200;background:rgba(15,23,42,.94);display:flex;align-items:center;justify-content:center;padding:12px;font-family:'Plus Jakarta Sans',sans-serif;color:#fff}
    .fa-card{width:100%;max-width:420px;max-height:100%;overflow:auto}
    .fa-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:15px}
    .fa-x{background:#334155;color:#fff;border:0;border-radius:10px;padding:6px 12px;font-size:13px;cursor:pointer}
    .fa-stage{position:relative;width:100%;aspect-ratio:3/4;border-radius:18px;overflow:hidden;background:#000}
    .fa-stage video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
    .fa-oval{position:absolute;inset:10% 17%;border:3px dashed rgba(255,255,255,.75);border-radius:50%;transition:border-color .2s}
    .fa-oval[data-tone=ok]{border-color:#34d399;border-style:solid}
    .fa-oval[data-tone=warn]{border-color:#fbbf24}
    .fa-msg{margin-top:12px;text-align:center;font-weight:700;font-size:16px;min-height:24px}
    .fa-msg[data-tone=bad]{color:#fda4af}
    .fa-sub{margin-top:4px;text-align:center;font-size:12px;color:#cbd5e1;min-height:16px}
    .fa-actions{display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap}
    .fa-btn{border:0;border-radius:12px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;background:#334155;color:#fff}
    .fa-btn.p{background:#4f46e5}
    .fa-btn[disabled]{opacity:.45;cursor:not-allowed}
    .fa-consent{background:#fff;color:#1e293b;border-radius:18px;padding:20px;font-size:14px;line-height:1.5}
    .fa-consent h3{margin:0 0 8px;font-size:17px}
    .fa-consent ul{margin:8px 0 8px 18px;padding:0}
    .fa-consent label{display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-weight:600}
    .fa-consent .fa-btn{background:#e2e8f0;color:#334155}
    .fa-consent .fa-btn.p{background:#4f46e5;color:#fff}
    .fa-panel{border:1px solid #e2e8f0;border-radius:14px;padding:14px;background:#f8fafc;font-size:13px;color:#475569}
    .fa-ph{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;color:#0f172a;font-size:14px}
    .fa-chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:#e2e8f0;color:#475569}
    .fa-chip[data-t=ok]{background:#d1fae5;color:#047857}
    .fa-chip[data-t=warn]{background:#fef3c7;color:#b45309}
    .fa-chip[data-t=bad]{background:#ffe4e6;color:#be123c}
    .fa-pbtn{margin-top:8px;border:0;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;background:#4f46e5;color:#fff}
    .fa-today{margin-top:6px;font-size:12px}
    .fa-rv{background:#fff;border:1px solid #f1f5f9;border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.05);padding:16px;margin-bottom:16px}
    .fa-rv h4{margin:0 0 10px;font-size:15px;color:#0f172a}
    .fa-rvrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px;border-radius:12px;background:rgba(254,243,199,.35);margin-bottom:8px;font-size:13px;color:#334155}
    .fa-rvrow img{width:56px;height:72px;object-fit:cover;border-radius:8px;background:#e2e8f0}
    .fa-rvrow .fa-i{flex:1;min-width:180px}
    .fa-rvrow a{color:#4f46e5;font-weight:600;text-decoration:underline;font-size:12px}
    .fa-rvbtns{display:flex;gap:6px}
    `;
    function injectCss() {
        if (document.getElementById('fa-css')) return;
        const s = document.createElement('style'); s.id = 'fa-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    function openUI(title) {
        injectCss();
        const el = document.createElement('div');
        el.className = 'fa-ov';
        el.innerHTML = `<div class="fa-card"><div class="fa-head"><b>${esc(title)}</b><button type="button" class="fa-x">Batal</button></div>
            <div class="fa-stage"><video autoplay playsinline muted></video><div class="fa-oval"></div></div>
            <div class="fa-msg"></div><div class="fa-sub"></div><div class="fa-actions"></div></div>`;
        document.body.appendChild(el);
        const $ = (s) => el.querySelector(s), prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const ui = {
            el, video: $('video'), stream: null, cancelled: false, onCancel: null,
            msg(t, tone) { const m = $('.fa-msg'); m.textContent = t || ''; m.dataset.tone = tone || ''; },
            sub(t) { $('.fa-sub').textContent = t || ''; },
            oval(tone) { $('.fa-oval').dataset.tone = tone || ''; },
            actions(list) {
                const box = $('.fa-actions'); box.innerHTML = '';
                (list || []).forEach((b) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'fa-btn' + (b.primary ? ' p' : ''); x.textContent = b.label; x.onclick = b.on; box.appendChild(x); });
            },
            lock() { $('.fa-x').style.display = 'none'; ui.actions([]); },
            hideVideo() { $('.fa-stage').style.display = 'none'; },
            stopCamera() { if (ui.stream) { ui.stream.getTracks().forEach((t) => t.stop()); ui.stream = null; } },
            close() { ui.stopCamera(); el.remove(); document.body.style.overflow = prevOverflow; }
        };
        $('.fa-x').onclick = () => { ui.cancelled = true; if (ui.onCancel) ui.onCancel(); ui.close(); };
        return ui;
    }

    /* ================= 7. PENGAMBILAN WAJAH + LIVENESS ================= */
    // Liveness sederhana: satu tantangan acak (kedip atau toleh kepala) lalu hadap lurus.
    // Ini menahan foto diam, tetapi tidak menahan video rekaman.
    async function acquire(ui, { models, samples }) {
        if (!models) return manualShot(ui);
        const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        const v = ui.video, challenge = Math.random() < 0.5 ? 'blink' : 'turn';
        const t0 = Date.now();
        let phase = 'align', neutral = [], base = 0, closed = false, turned = false, frontOk = 0;
        ui.msg('Posisikan wajah di dalam bingkai');
        while (phase !== 'sample') {
            if (ui.cancelled) throw new Cancel();
            if (Date.now() - t0 > CFG.LIVENESS_TIMEOUT_MS) throw new Error('Waktu habis. Pastikan wajah terlihat jelas dan ikuti instruksi, lalu coba lagi.');
            const dets = await faceapi.detectAllFaces(v, opts).withFaceLandmarks();
            if (ui.cancelled) throw new Cancel();
            if (dets.length > 1) { ui.oval('warn'); ui.msg('Hanya satu wajah yang boleh terlihat'); neutral = []; await sleep(80); continue; }
            if (dets.length === 0) {
                if (phase === 'align') { ui.oval('warn'); ui.msg('Wajah belum terdeteksi'); neutral = []; }
                await sleep(80); continue;
            }
            const det = dets[0], box = det.detection.box, lm = det.landmarks.positions;
            const fw = box.width / v.videoWidth, cx = (box.x + box.width / 2) / v.videoWidth, cy = (box.y + box.height / 2) / v.videoHeight;
            const e = (ear(lm.slice(36, 42)) + ear(lm.slice(42, 48))) / 2, yaw = yawOf(lm);

            if (phase === 'align') {
                let hint = null;
                if (fw < 0.28) hint = 'Dekatkan wajah ke kamera';
                else if (fw > 0.8) hint = 'Jauhkan wajah sedikit';
                else if (Math.abs(cx - 0.5) > 0.2 || Math.abs(cy - 0.5) > 0.25) hint = 'Posisikan wajah di tengah bingkai';
                else if (Math.abs(yaw - 0.5) > 0.12) hint = 'Hadap lurus ke kamera';
                if (hint) { ui.oval('warn'); ui.msg(hint); neutral = []; }
                else {
                    ui.oval('ok'); ui.msg('Tahan sebentar…'); neutral.push(e);
                    if (neutral.length >= 5) {
                        base = median(neutral); phase = 'challenge';
                        ui.msg(challenge === 'blink' ? 'Kedipkan mata Anda' : 'Tolehkan kepala ke satu sisi, lalu hadap depan lagi');
                    }
                }
            } else if (phase === 'challenge') {
                if (challenge === 'blink') {
                    if (e < base * 0.78) closed = true;
                    else if (closed && e > base * 0.9) phase = 'front';
                } else {
                    const dv = Math.abs(yaw - 0.5);
                    if (dv > 0.16) turned = true;
                    else if (turned && dv < 0.09) phase = 'front';
                }
                if (phase === 'front') ui.msg('Bagus. Hadap lurus ke kamera…');
            } else if (phase === 'front') {
                if (Math.abs(yaw - 0.5) < 0.1 && fw >= 0.28 && fw <= 0.8) { if (++frontOk >= 2) phase = 'sample'; } else frontOk = 0;
            }
            await sleep(50);
        }
        ui.msg('Mengambil data wajah…'); ui.oval('ok');
        const descriptors = []; let frame = null, miss = 0;
        while (descriptors.length < samples) {
            if (ui.cancelled) throw new Cancel();
            const d = await faceapi.detectSingleFace(v, opts).withFaceLandmarks().withFaceDescriptor();
            if (d) { descriptors.push(d.descriptor); if (!frame) frame = grab(v); await sleep(250); }
            else if (++miss > 20) throw new Error('Wajah tidak terbaca. Coba lagi dengan pencahayaan lebih baik.');
            else await sleep(100);
        }
        return { descriptors, frame };
    }
    // Mode cadangan: tanpa pencocokan, siswa menekan tombol untuk mengambil foto
    function manualShot(ui) {
        return new Promise((ok, no) => {
            ui.onCancel = () => no(new Cancel());
            ui.msg('Posisikan wajah di dalam bingkai, lalu ambil foto');
            ui.sub('Model wajah belum termuat. Foto ini dikirim untuk ditinjau guru.');
            ui.actions([{ label: 'Ambil foto', primary: true, on: () => ok({ descriptors: null, frame: grab(ui.video) }) }]);
        });
    }

    /* ================= 8. PENCOCOKAN ================= */
    function evaluate(enrolled, live) {
        // Per contoh langsung: jarak terdekat ke contoh terdaftar; hasil akhir = rata-rata
        const per = live.map((d) => Math.min(...enrolled.map((e) => faceapi.euclideanDistance(d, e))));
        const score = +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(3);
        const status = score < CFG.T_VERIFIED ? 'VERIFIED' : score <= CFG.T_REJECT ? 'PENDING_REVIEW' : 'REJECTED';
        return { score, status };
    }

    /* ================= 9. FOTO: KOMPRES + WATERMARK ================= */
    function makeJpeg(src, lines) {
        const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
        const k = Math.min(1, CFG.IMG_MAX / Math.max(sw, sh)), w = Math.round(sw * k), h = Math.round(sh * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0, w, h);
        const fs = Math.max(10, Math.round(w / 34)), pad = 6, lh = fs + 3, bandH = lines.length * lh + pad * 2;
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, h - bandH, w, bandH);
        g.fillStyle = '#fff'; g.font = `${fs}px Arial, sans-serif`; g.textBaseline = 'top';
        lines.filter(Boolean).forEach((t, i) => g.fillText(t, pad, h - bandH + pad + i * lh, w - pad * 2));
        return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('Gagal membuat foto.'))), 'image/jpeg', CFG.JPEG_Q));
    }

    /* ================= 10. PRESENSI ================= */
    async function presensi(jenis, ctx, opt) {
        opt = opt || {};
        if (!CFG.ENABLED) return { disabled: true };
        const sid = ctx.siswa.id, nama = ctx.siswa.nama;
        S.sid = sid; S.nama = nama;
        const ui = openUI('Presensi ' + (jenis === 'masuk' ? 'Masuk' : 'Pulang'));
        try {
            ui.msg('Menyalakan kamera dan memuat model wajah…');
            ui.sub('Jika model belum siap dalam 8 detik, foto dikirim untuk ditinjau guru.');
            const cam = startCamera(ui);
            const [models] = await Promise.all([opt.forceManual ? false : modelsReady(), cam]);
            let enrolled = [];
            if (models) {
                enrolled = await API.getEnrollment(sid);
                if (!enrolled.length) { ui.close(); return { needEnroll: true }; }
            }
            ui.sub('');
            const res = await acquire(ui, { models, samples: CFG.VERIFY_SAMPLES });
            ui.lock(); ui.hideVideo(); ui.stopCamera();

            let score = null;
            const modelGagal = !res.descriptors;   // model gagal dimuat, atau dikirim manual setelah tidak cocok
            if (!modelGagal) {
                const ev = evaluate(enrolled, res.descriptors);
                score = +ev.score.toFixed(4);
                if (ev.status === 'REJECTED') {
                    S.fail++; ui.close();
                    if (S.fail >= CFG.MAX_FAIL && confirm('Wajah belum cocok ' + S.fail + ' kali. Kirim presensi ini untuk ditinjau guru pembimbing?')) {
                        return presensi(jenis, ctx, { forceManual: true });
                    }
                    return { rejected: true, score: ev.score, fail: S.fail };
                }
                S.fail = 0;
            }
            const perkiraan = modelGagal ? 'PENDING_REVIEW' : evaluate(enrolled, res.descriptors).status;

            ui.msg('Mengompres dan mengunggah foto…');
            const p = ctx.pos, waktu = new Date().toISOString(), lines = [
                nama, stampWib(), ctx.industri && ctx.industri.nama,
                `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} (±${Math.round(p.accuracy)} m)`,
                `PRESENSI ${jenis.toUpperCase()} · ${perkiraan}${score != null ? ' (' + score.toFixed(2) + ')' : ''}`
            ];
            const blob = await makeJpeg(res.frame, lines);
            const url = await uploadRetry(blob, { tipe: jenis, nis: ctx.siswa.nis, nama, waktu });
            ui.msg('Menyimpan presensi…');
            const data = await API.catat({ jenis, pos: p, url, score, modelGagal });
            ui.close();
            return { status: data.verification_status || perkiraan, score, modelGagal, data };
        } catch (e) {
            ui.close();
            if (e && e.cancel) return { cancelled: true };
            throw e;
        }
    }

    /* ================= 11. PENDAFTARAN WAJAH (DENGAN PERSETUJUAN) ================= */
    function askConsent() {
        injectCss();
        return new Promise((ok) => {
            const el = document.createElement('div');
            el.className = 'fa-ov';
            el.innerHTML = `<div class="fa-card"><div class="fa-consent"><h3>Persetujuan data wajah</h3>${CFG.CONSENT_HTML}
                <label><input type="checkbox" id="fa-agree" style="margin-top:3px"> Saya telah membaca dan menyetujui.</label>
                <div class="fa-actions" style="margin-top:8px"><button type="button" class="fa-btn" data-a="no">Batal</button><button type="button" class="fa-btn p" data-a="yes" disabled>Setuju dan lanjutkan</button></div></div></div>`;
            document.body.appendChild(el);
            const chk = el.querySelector('#fa-agree'), yes = el.querySelector('[data-a=yes]');
            chk.onchange = () => { yes.disabled = !chk.checked; };
            el.querySelector('[data-a=no]').onclick = () => { el.remove(); ok(false); };
            yes.onclick = () => { el.remove(); ok(true); };
        });
    }
    async function enroll() {
        if (!S.sid) return toast('Data siswa belum dimuat. Muat ulang halaman.', 'error');
        try {
            if ((await API.getEnrollment(S.sid)).length) { toast('Wajah Anda sudah terdaftar. Untuk mendaftar ulang, hubungi guru pembimbing atau Pokja PKL.', 'error'); return refreshPanel(); }
        } catch (e) { return toast('Gagal memeriksa pendaftaran: ' + e.message, 'error'); }
        if (!(await askConsent())) return;
        const ui = openUI('Pendaftaran Wajah');
        try {
            ui.msg('Menyalakan kamera dan memuat model wajah…');
            const cam = startCamera(ui);
            const [models] = await Promise.all([modelsReady(), cam]);
            if (!models) { ui.close(); return toast('Model pengenalan wajah belum termuat. Coba lagi dengan koneksi yang lebih baik.', 'error'); }
            const res = await acquire(ui, { models: true, samples: CFG.ENROLL_SAMPLES });
            ui.lock(); ui.hideVideo(); ui.stopCamera();
            // Semua contoh harus berasal dari wajah yang sama
            for (let i = 1; i < res.descriptors.length; i++) {
                if (faceapi.euclideanDistance(res.descriptors[0], res.descriptors[i]) > CFG.T_VERIFIED) throw new Error('Wajah tidak konsisten antar pengambilan. Ulangi pendaftaran.');
            }
            ui.msg('Menyimpan…');
            // Tiga contoh dirata-rata menjadi satu descriptor (128 angka) sesuai kolom siswa_wajah.descriptor
            const mean = Array.from({ length: 128 }, (_, i) => +(res.descriptors.reduce((t, d) => t + d[i], 0) / res.descriptors.length).toFixed(6));
            await API.daftar(mean);
            ui.close();
            toast('Wajah berhasil didaftarkan. Anda dapat melakukan presensi.');
            refreshPanel();
        } catch (e) {
            ui.close();
            if (!(e && e.cancel)) toast('Pendaftaran gagal: ' + e.message, 'error');
        }
    }

    /* ================= 12. PANEL DI HALAMAN PRESENSI SISWA ================= */
    async function renderPanel(el, info) {
        if (!el || !CFG.ENABLED) return;
        injectCss();
        S.panelEl = el; if (info) { S.sid = info.sid; S.nama = info.nama; }
        el.innerHTML = `<div class="fa-panel"><div class="fa-ph"><b>Verifikasi wajah</b><span class="fa-chip" id="fa-chip">Memeriksa…</span></div>
            <div>Presensi memakai kamera depan secara langsung. Ikuti instruksi kedip atau toleh kepala.</div>
            <div id="fa-model" style="margin-top:4px;font-size:12px"></div><div class="fa-today" id="fa-today"></div><div id="fa-act"></div></div>`;
        setModel(S.model);
        preload();
        const chip = document.getElementById('fa-chip'), act = document.getElementById('fa-act');
        try {
            const enr = await API.getEnrollment(S.sid);
            S.enrolled = enr.length > 0;
            chip.textContent = S.enrolled ? 'Wajah terdaftar' : 'Belum terdaftar'; chip.dataset.t = S.enrolled ? 'ok' : 'warn';
            if (!S.enrolled) act.innerHTML = '<button type="button" class="fa-pbtn" onclick="FACE.enroll()">Daftarkan Wajah</button>';
            else act.innerHTML = '<div style="margin-top:6px;font-size:12px">Untuk mendaftar ulang wajah, hubungi guru pembimbing atau Pokja PKL.</div>';
        } catch (e) { chip.textContent = 'Status tidak diketahui'; act.textContent = e.message; }
        try {
            const rows = await API.hariIni(S.sid, todayWib()), t = document.getElementById('fa-today');
            if (t && rows.length) t.innerHTML = 'Hari ini: ' + rows.map((r) => {
                const l = LABEL[r.verification_status] || [r.verification_status || '-', ''];
                return `${r.jenis === 'masuk' ? 'Masuk' : 'Pulang'} <span class="fa-chip" data-t="${l[1]}">${esc(l[0])}</span>`;
            }).join(' · ');
        } catch (e) { /* tampilan tambahan saja */ }
    }
    function refreshPanel() { if (S.panelEl && document.body.contains(S.panelEl)) renderPanel(S.panelEl); }

    /* ================= 13. TINJAUAN GURU (PENDING_REVIEW) ================= */
    const canReview = () => { try { return ['superadmin', 'pokja', 'guru'].includes(window.app.currentUser.role); } catch (e) { return false; } };
    const driveThumb = (u) => { const m = /\/d\/([\w-]{15,})|[?&]id=([\w-]{15,})/.exec(u || ''); return m ? 'https://drive.google.com/thumbnail?id=' + (m[1] || m[2]) + '&sz=w200' : ''; };
    const rvBtn = (label, js, tone) => (typeof B === 'function' ? B(label, js, tone) : `<button onclick="${js}">${label}</button>`);

    async function renderReview(box) {
        if (!box || !canReview() || !CFG.ENABLED) return;
        injectCss(); S.reviewEl = box;
        try {
            const rows = await API.antrianTinjau();
            if (!rows.length) { box.innerHTML = ''; return; }
            const ids = [...new Set(rows.map((r) => r.siswa_id))];
            const sis = await q(sbClient.from('siswa').select('id,nama,kelas').in('id', ids));
            const nm = Object.fromEntries(sis.map((s) => [s.id, s]));
            box.innerHTML = `<div class="fa-rv"><h4>Presensi wajah menunggu tinjauan (${rows.length})</h4>${rows.map((r) => {
                const s = nm[r.siswa_id] || { nama: 'Siswa', kelas: '' }, th = driveThumb(r.photo_url);
                const w = new Date(r.waktu).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).replace('.', ':');
                return `<div class="fa-rvrow">${th ? `<img src="${esc(th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
                    <div class="fa-i"><b>${esc(s.nama)}</b> <span style="color:#64748b">${esc(s.kelas || '')}</span><br>
                    ${esc(r.tanggal.split('-').reverse().join('-'))} · ${r.jenis === 'masuk' ? 'Masuk' : 'Pulang'} ${w}<br>
                    ${r.face_distance != null ? 'Jarak wajah ' + Number(r.face_distance).toFixed(2) + ' (batas otomatis 0.45)' : 'Tanpa pencocokan (model gagal dimuat atau dikirim manual)'}<br>
                    ${r.photo_url && /^https?:\/\//i.test(r.photo_url) ? `<a href="${esc(r.photo_url)}" target="_blank" rel="noopener noreferrer">Buka foto</a>` : '<span style="color:#be123c">Foto tidak ada</span>'}</div>
                    <div class="fa-rvbtns">${rvBtn('Setujui', `FACE.review('${esc(r.id)}',true)`, 'emerald')}${rvBtn('Tolak', `FACE.review('${esc(r.id)}',false)`, 'rose')}</div></div>`;
            }).join('')}</div>`;
        } catch (e) { box.innerHTML = `<div class="fa-rv" style="color:#be123c;font-size:13px">Gagal memuat antrian tinjauan wajah: ${esc(e.message)}</div>`; }
    }
    async function review(id, setuju) {
        if (!setuju && !confirm('Tolak presensi ini? Presensi tidak akan dihitung hadir.')) return;
        try {
            await API.tinjau(id, setuju);
            toast(setuju ? 'Presensi disetujui.' : 'Presensi ditolak.');
            if (S.reviewEl) renderReview(S.reviewEl);
            if (window.STAFF4 && STAFF4.rekapLoad && document.getElementById('rk-hasil')) STAFF4.rekapLoad();
        } catch (e) { toast('Gagal: ' + e.message, 'error'); }
    }
    async function resetWajah(sid) {
        if (!confirm('Reset pendaftaran wajah siswa ini? Siswa harus mendaftarkan wajah lagi sebelum presensi berikutnya.')) return;
        try { await API.reset(sid); toast('Pendaftaran wajah direset.'); } catch (e) { toast('Gagal: ' + e.message, 'error'); }
    }

    /* ================= 14. ANTARMUKA PUBLIK ================= */
    window.FACE = {
        CFG, enabled: () => CFG.ENABLED, preload, presensi, enroll, renderPanel, renderReview, review, resetWajah,
        _t: { ear, yawOf, evaluate, median, safeName }
    };
})();
