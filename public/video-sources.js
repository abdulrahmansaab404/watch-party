// public/video-sources.js
//
// >>> THIS IS THE ONLY FILE YOU NEED TO EDIT TO ROUTE YOUR OWN VIDEO SOURCE <<<
//
// Fill in a URL per episode for any video you have the legal right to stream
// to your group (files you own, a Plex/Jellyfin/Emby HTTP stream you run,
// a private HLS endpoint, etc). Two source types are supported per episode:
//
//   { quality: "1080p", type: "mp4", url: "https://your-host/s1e1-1080p.mp4" }
//   { quality: "auto",  type: "hls", url: "https://your-host/s1e1/master.m3u8" }
//
// - "mp4": a direct progressive file. List one entry per resolution you have;
//   each viewer's quality dropdown is populated from this list and switching
//   only affects that viewer's own video element (a local src swap that
//   restores position + play state — it never touches anyone else).
// - "hls": an adaptive stream (.m3u8). The quality dropdown is populated from
//   the levels inside the playlist automatically via hls.js, again per-viewer.
// You can mix mp4 and hls across different episodes if you need to.
//
// "mediaId" below (e.g. "1-1") is just a sync identifier shared over the
// wire — it never leaves your server's reach and contains no video data.

const VIDEO_LIBRARY = {
  title: 'Stranger Things',
  seasons: [
    {
      season: 1,
      episodes: [
        {
          episode: 1,
          title: 'Chapter One: The Vanishing of Will Byers',
          sources: [
            { quality: '1080p', type: 'mp4', url: 'https://www.cineby.at/tv/66732/1/1' },
            //{ quality: '720p',  type: 'mp4', url: 'https://your-host.example/st/s1e1-720p.mp4' },
          ],
        },
        {
          episode: 2,
          title: 'Chapter Two: The Weirdo on Maple Street',
          sources: [],
        },
        // Add the rest of season 1's episodes the same way...
      ],
    },
    // Add season 2, 3, 4... following the same shape.
  ],
};

// Used as a fallback label in the UI before any source URL is filled in.
const VIDEO_LIBRARY_READY = VIDEO_LIBRARY.seasons.some((s) =>
  s.episodes.some((e) => e.sources.length > 0)
);
