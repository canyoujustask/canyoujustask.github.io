import './style.css';
import { SoundEngine } from './audio';
import samples from 'virtual:audio-library';
import { Experience } from './field';
import { connectMedia } from './media';
import { connectProjectContent } from './project-content';

const audio = new SoundEngine(samples);
const soundButton = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
const soundLabel = document.querySelector('#sound-label')!;
const soundStatus = document.querySelector('#sound-status')!;
const announcement = document.querySelector('#announcement')!;
const motionButton = document.querySelector<HTMLButtonElement>('#motion-toggle')!;
const volume = document.querySelector<HTMLInputElement>('#volume')!;
const volumeValue = document.querySelector<HTMLOutputElement>('#volume-value')!;
volume.addEventListener('input', () => {
  audio.setVolume(Number(volume.value) / 100);
  const label = `%${Math.round(audio.volume * 100)}`;
  volumeValue.value = label;
  volume.setAttribute('aria-valuetext', label);
});
let experience: Experience | undefined;
async function selectSound(index: number) {
  try { await audio.select(index); }
  catch (error) { announcement.textContent = 'Ses başlatılamadı. Yeniden dokunarak deneyebilirsin.'; console.error(error); }
}

function updateAudio() {
  experience?.updateStates();
  soundButton.disabled = !audio.available;
  soundButton.title = audio.available ? '' : 'Henüz ses eklenmedi';
  document.body.classList.toggle('playing', audio.engaged && !audio.mediaMuted);
  soundLabel.textContent = audio.engaged ? 'Sesi durdur' : 'Sesi aç';
  soundButton.setAttribute('aria-label', audio.engaged ? 'Sesi durdur' : 'Sesi aç');
  soundStatus.textContent = audio.mediaMuted ? 'VİDEO' : audio.pendingCount ? 'BEKLİYOR' : audio.transitioning ? 'GEÇİŞ' : audio.available ? 'SES' : 'SES YOK';
  announcement.textContent = audio.mediaMuted ? 'Video için site sesi kısıldı.' : !audio.available ? 'Henüz ses eklenmedi.' : audio.pendingCount ? 'Seçilen ses hazırlanıyor; varsa geçerli geçişin bitmesi bekleniyor.' : audio.transitioning ? 'Sesler arasında dört saniyelik geçiş.' : audio.engaged ? 'Seçilen blob çalıyor.' : 'Ses durduruldu.';
}
audio.onChange = updateAudio;
connectMedia(audio);
connectProjectContent();
soundButton.addEventListener('click', () => { if (audio.engaged) audio.stopAll(); else void selectSound(audio.resumeIndex); });
try { experience = new Experience(audio, index => void selectSound(index)); }
catch (error) { console.warn('Görsel etkileşim desteklenmiyor; içerik okunabilir durumda.', error); document.querySelector('.field-note')?.remove(); }
motionButton.addEventListener('click', () => {
  if (!experience) return;
  experience.setReduced(!experience.reduced);
  motionButton.setAttribute('aria-pressed', String(experience.reduced));
  motionButton.title = experience.reduced ? 'Hareketi aç' : 'Hareketi azalt';
  motionButton.setAttribute('aria-label', motionButton.title);
});
if (experience?.reduced) { experience.setReduced(true); motionButton.setAttribute('aria-pressed', 'true'); }
updateAudio();
const dots = [...document.querySelectorAll('.signal-dots i')];
window.setInterval(() => {
  const level = audio.engaged && !audio.mediaMuted ? Math.max(...audio.levels) : 0;
  dots.forEach((dot, i) => dot.classList.toggle('active', level > .01 + i * .12));
}, 90);
window.addEventListener('pagehide', () => audio.stopAll());
