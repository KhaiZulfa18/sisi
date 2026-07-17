# Sisi — To-Do List

Ekstensi Chrome berupa to-do list minimalis yang tampil di **side panel** browser. Semua tugas tersimpan lokal di perangkatmu (via `chrome.storage.local`) — tidak ada server, tidak ada akun, tidak ada tracking.

## Fitur

- **Side panel bawaan Chrome** — buka lewat klik ikon toolbar atau shortcut `Ctrl+Shift+S` (`Cmd+Shift+S` di Mac), tanpa membuka tab/window baru.
- **Tag lewat `#`** — tulis `review PR dashboard #kerja #urgent` dan tag otomatis terpisah dari teks tugas, lengkap dengan warna yang konsisten per nama tag.
- **Autocomplete tag** — saat mengetik `#`, muncul saran dari tag yang pernah dipakai; navigasi dengan panah atas/bawah, pilih dengan `Tab`/`Enter`.
- **Filter berdasarkan tag** — klik chip tag untuk menyaring daftar aktif maupun riwayat.
- **Drag & drop reorder** — urutkan ulang tugas lewat drag handle (⠿).
- **Checklist → Riwayat** — centang tugas selesai, pindahkan ke tab Riwayat, atau kembalikan (restore) ke daftar aktif kapan saja.
- **Tema** — 7 pilihan tema (Auto/sistem, Kertas, Gelap, Laut, Senja, Ungu, Hutan), termasuk auto dark-mode mengikuti preferensi sistem.
- **Data 100% lokal** — memakai permission `storage` saja, tidak ada akses ke isi halaman web.

## Struktur proyek

```
todo-extension/
├── manifest.json     # Manifest V3
├── background.js     # Service worker — buka side panel saat ikon diklik
├── sidepanel.html     # Markup UI
├── sidepanel.css      # Styling + tema
├── sidepanel.js        # Logic: state, storage, render, drag & drop
└── icons/              # Ikon 16/48/128 px
```

## Cara install di Chrome (mode developer)

Ekstensi ini belum dipublikasikan ke Chrome Web Store, jadi install-nya lewat mode **Load unpacked**:

1. Buka Chrome, akses `chrome://extensions`.
2. Aktifkan **Developer mode** (toggle di kanan atas).
3. Klik **Load unpacked**.
4. Pilih folder proyek ini (`todo-extension`).
5. Ekstensi **Sisi — To-Do List** akan muncul di daftar dan ikonnya tampil di toolbar.
6. Klik ikon toolbar (atau tekan `Ctrl+Shift+S` / `Cmd+Shift+S`) untuk membuka side panel dan mulai menambah tugas.

> Setelah mengubah kode (html/css/js), klik tombol **reload** (⟲) pada kartu ekstensi di `chrome://extensions` agar perubahan diterapkan.

Ekstensi ini juga kompatibel dengan browser berbasis Chromium lain yang mendukung Manifest V3 side panel (mis. Microsoft Edge, Brave) lewat langkah yang sama.

## Development

Tidak ada build step atau dependency — murni HTML/CSS/JS vanilla. Cukup edit file, lalu reload ekstensi di `chrome://extensions` untuk melihat perubahan.
