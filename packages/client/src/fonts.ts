/// <reference types="vite/client" />
import g9 from 'galmuri/dist/Galmuri9.woff2?url';
import g11 from 'galmuri/dist/Galmuri11.woff2?url';
import g11b from 'galmuri/dist/Galmuri11-Bold.woff2?url';
import gm11 from 'galmuri/dist/GalmuriMono11.woff2?url';

/** 갈무리(Galmuri, OFL-1.1) — 한글 픽셀 글꼴. 캔버스 텍스트가 쓰기 전에 반드시 로드한다. */
export async function loadFonts() {
  const faces = [
    new FontFace('Galmuri9', `url(${g9})`),
    new FontFace('Galmuri11', `url(${g11})`),
    new FontFace('Galmuri11', `url(${g11b})`, { weight: '700' }),
    new FontFace('GalmuriMono11', `url(${gm11})`),
  ];
  await Promise.all(
    faces.map(async (f) => {
      try {
        document.fonts.add(await f.load());
      } catch (e) {
        console.warn('font load failed', e);
      }
    }),
  );
}
