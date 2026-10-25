const $ = id => document.getElementById(id);
let timeline = { page: null, subtitles: [], marks: [] };
let ready = false;

const log = s => { $("log").textContent += s + "\n"; $("log").scrollTop = 9e9; };

/* ---------- 页面读取（MAIN world） ---------- */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function execInPage(tabId, func) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func
  });
  return result;
}

async function readPageInfo(tabId) {
  return execInPage(tabId, () => {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const bvid = m ? m[1] : null;
    let cid = null;
    try {
      const s = window.__INITIAL_STATE__;
      cid = s?.videoData?.cid || s?.cid || s?.videoInfo?.cid || s?.epInfo?.cid || null;
    } catch (e) {}
    const v = document.querySelector("video");
    return { bvid, cid, hasVideo: !!v, currentTime: v ? v.currentTime : null };
  });
}

/* ---------- WBI 签名 ---------- */
function md5(str) {
  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
  function add(a, b) { return (a + b) | 0; }
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length, bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Uint32Array(padded.buffer, i, 16);
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F, g;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }
      const tmp = D; D = C; C = B;
      B = add(B, rotl(add(add(A, F), add(K[j], M[g])), S[j]));
      A = tmp;
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  const out = new Uint8Array(16), odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return [...out].map(b => b.toString(16).padStart(2, "0")).join("");
}

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,
  27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,
  37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
  22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function mixinKey(orig) {
  return MIXIN_TAB.map(n => orig[n]).join("").slice(0, 32);
}

async function getWbiMixin() {
  const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
  const j = await r.json();
  const img = j?.data?.wbi_img?.img_url || "";
  const sub = j?.data?.wbi_img?.sub_url || "";
  const imgKey = img.slice(img.lastIndexOf("/") + 1).split(".")[0];
  const subKey = sub.slice(sub.lastIndexOf("/") + 1).split(".")[0];
  return mixinKey(imgKey + subKey);
}

function encWbi(params, mixin) {
  const wts = Math.round(Date.now() / 1000);
  const p = { ...params, wts };
  const query = Object.keys(p).sort().map(k => {
    const v = String(p[k]).replace(/[!'()*]/g, "");
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join("&");
  return `${query}&w_rid=${md5(query + mixin)}`;
}

/* ---------- 字幕获取 ---------- */
async function getCidFallback(bvid) {
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: "include" });
    const j = await r.json();
    return j?.data?.cid || null;
  } catch (e) { return null; }
}

async function fetchSubtitleTracks(bvid, cid) {
  // 1) WBI 接口
  try {
    const mixin = await getWbiMixin();
    const q = encWbi({ bvid, cid }, mixin);
    const r = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${q}`, { credentials: "include" });
    const j = await r.json();
    if (j.code === 0 && j.data?.subtitle?.subtitles?.length) {
      return j.data.subtitle.subtitles;
    }
  } catch (e) {}
  // 2) 旧接口回退
  try {
    const r = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { credentials: "include" });
    const j = await r.json();
    if (j.code === 0 && j.data?.subtitle?.subtitles?.length) {
      return j.data.subtitle.subtitles;
    }
  } catch (e) {}
  return [];
}

async function fetchSubtitleBody(url) {
  if (url.startsWith("//")) url = "https:" + url;
  const r = await fetch(url);
  const j = await r.json();
  return (j.body || []).map(x => ({
    start: Number(x.from), end: Number(x.to), text: x.content
  }));
}

/* ---------- 按钮 ---------- */
$("load").onclick = async () => {
  $("log").textContent = "";
  try {
    const tab = await activeTab();
    if (!/bilibili\.com\/video\//.test(tab.url || "")) {
      return log("请先打开一个 B站视频页（www.bilibili.com/video/BV...）");
    }
    const info = await readPageInfo(tab.id);
    let { bvid, cid } = info;
    if (!bvid) return log("URL 中未识别到 BV 号");
    if (!cid) {
      log("页面变量未取到 cid，尝试接口获取…");
      cid = await getCidFallback(bvid);
    }
    if (!cid) return log("无法获取 cid，请确认视频可正常播放");
    timeline.page = { bvid, cid, url: tab.url };
    log(`视频：${bvid}，cid：${cid}`);

    log("请求字幕…");
    const tracks = await fetchSubtitleTracks(bvid, cid);
    if (!tracks.length) {
      log("该视频没有可用字幕（或未登录/被风控）。");
      log("提示：请在 Edge 中登录 B站后重试；仍无字幕说明视频本身无字幕轨。");
      ready = true;
      $("mark").disabled = false;
      $("export").disabled = false;
      return;
    }
    const pick = tracks.find(t => /zh|ai-zh/i.test(t.lan || "")) || tracks[0];
    log(`字幕轨：${pick.lan_doc || pick.lan}，正在拉取内容…`);
    const subs = await fetchSubtitleBody(pick.subtitle_url);
    timeline.subtitles = subs;
    log(`字幕 ${subs.length} 段，已就绪。`);
    ready = true;
    $("mark").disabled = false;
    $("export").disabled = false;
  } catch (e) {
    log("出错：" + e.message);
  }
};

$("mark").onclick = async () => {
  try {
    const tab = await activeTab();
    const t = await execInPage(tab.id, () => {
      const v = document.querySelector("video");
      return v ? v.currentTime : null;
    });
    if (t == null) return log("未找到 video 元素，请确认视频已开始播放");
    const near = timeline.subtitles.find(s => t >= s.start - 0.5 && t <= s.end + 0.5);
    timeline.marks.push({
      time: Math.round(t * 100) / 100,
      matched_text: near ? near.text : null,
      matched_range: near ? [near.start, near.end] : null
    });
    log(`✓ 已标记 ${t.toFixed(2)}s${near ? " → " + near.text.slice(0, 18) : "（附近无字幕）"}`);
  } catch (e) { log("标记失败：" + e.message); }
};

$("export").onclick = () => {
  const blob = new Blob([JSON.stringify(timeline, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `bili-timeline-${Date.now()}.json` });
  log("已导出 JSON。");
};