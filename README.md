# GRAND / 88

Piano online 88 tuts (A0–C8) memakai sampel grand piano Yamaha C5 dari Salamander Grand Piano. Berjalan sebagai static site: tanpa build, tanpa dependency JavaScript.

**Live:** https://ikyletwar.github.io/grand-piano-88/

## Menjalankan

Dari folder `grand-piano-88/`:

```bash
python3 -m http.server 8080
```

Buka `http://localhost:8080`.

### Offline

- Lewat server lokal (`http://localhost`): seluruh aset, termasuk 30 sample MP3, berada di folder `samples/`. Tidak perlu internet.
- Lewat GitHub Pages: kunjungi sekali saat online. Service worker (`sw.js`) menyimpan HTML, CSS, JS, dan ke-30 sample ke Cache Storage. Kunjungan berikutnya tetap berfungsi tanpa koneksi.
- Dibuka langsung sebagai `file://`: browser memblokir `fetch` ke file lokal, sehingga aplikasi jatuh ke CDN dan tetap butuh internet. Pakai server lokal atau GitHub Pages untuk mode offline penuh.

## Kontrol

| Aksi | Kontrol |
|---|---|
| Memainkan tuts | Klik / sentuh tuts, drag melintasi tuts untuk glissando |
| Tuts putih | `Q W E R T Y U I O P A S D F G H J K L Z X C V B N M` berurutan dari kiri ke kanan, mulai dari `C3` |
| Tuts hitam | Tahan `Shift` + huruf yang sama; memainkan tuts hitam di sebelah kanan tuts putih tersebut, atau di sebelah kiri untuk `E` dan `B` |
| Sustain pedal | Tahan `Space` atau tombol Sustain |
| Geser peta keyboard | `−` / `=` atau tombol di toolbar, satu oktaf per langkah (`C1`–`C4`) |
| Label not | `` ` `` (backtick) atau toggle Label not |
| Reverb | toggle Reverb |
| Navigasi tuts via keyboard | Fokus area piano, `←` / `→`, lalu `Enter` untuk memainkan |
| Tampilan | 88 / 24 / 12 tuts |
| Demo | tombol Putar demo |

Velocity mengikuti posisi klik pada tuts: makin dekat ujung bawah, makin keras.

## Audio

- 30 file MP3 Salamander Grand Piano (Yamaha C5, direkam dengan AKG C414).
- 88 pitch dihasilkan dengan merekonstruksi pitch dari sample terdekat lewat `AudioBufferSourceNode.playbackRate`; selisih maksimal ±1,5 semitone.
- Envelope serangan 6 ms, release 240 ms (tanpa pedal) atau 1,8 s (pedal ditekan), ditambah convolver reverb ringan yang dibangkitkan secara prosedural.
- Sumber sample dicoba berurutan: `./samples/`, `https://tonejs.github.io/audio/salamander/`, `https://cdn.jsdelivr.net/gh/Tonejs/audio@master/salamander/`.

Lisensi dan atribusi: lihat [CREDITS.md](CREDITS.md).

## Struktur

```text
index.html   markup, kontrol, atribusi
styles.css   tampilan case piano, tuts, layout responsif, reduced-motion
app.js       loader sample, Web Audio engine, input pointer/keyboard, demo
sw.js        service worker: cache HTML/CSS/JS + 30 sample untuk offline
samples/     mirror 30 sample MP3
```
