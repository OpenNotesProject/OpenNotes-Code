/* -------------------------
   CONFIG: set your repo here
   ------------------------- */
const CONFIG = {
  owner: "OpenNotesProject",
  repo: "Notes",
  branch: "main",
  rootPath: "", // e.g. "notes"
  // OPTIONAL: for private repos or higher rate limits you can add a personal access token here for local testing.
  // WARNING: embedding tokens in client-side code is insecure. Prefer a server-side proxy in production.
  token: ''
};

/* -------------------------
   STATE & ELEMENTS
   ------------------------- */
const state = { tree: null, notesIndex: [], currentNote: null };
const subjectsDropdown = document.getElementById('subjectsDropdown');
const noteTitleEl = document.getElementById('noteTitle');
const noteContentEl = document.getElementById('noteContent');
const noteTopicEl = document.getElementById('noteTopic');
const noteInfoEl = document.getElementById('noteInfo');
const currentPathEl = document.getElementById('currentPath');
const statusEl = document.getElementById('status');
const searchInput = document.getElementById('globalSearch');
const searchResultsEl = document.getElementById('searchResults');
const shareBtn = document.getElementById('shareBtn');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const recentListEl = document.getElementById('recentList');

/* -------------------------
   Initialize mermaid
   ------------------------- */
if(window.mermaid){
  try{
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
      flowchart: { curve: 'basis' }
    });
  }catch(e){
    console.warn('Mermaid init failed', e);
  }
}

/* -------------------------
   URL helpers
   ------------------------- */
function setURL(path){
  const url = new URL(window.location);
  url.searchParams.set('note', path);
  window.history.replaceState({}, '', url);
}
function getURLNote(){
  const url = new URL(window.location);
  return url.searchParams.get('note');
}

/* -------------------------
   GitHub helpers
   ------------------------- */
function ghContentsUrl(path=''){
  const base = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents`;
  const full = CONFIG.rootPath ? `${CONFIG.rootPath}/${path}` : path;
  const encoded = full ? '/' + encodeURIComponent(full).replace(/%2F/g,'/') : '';
  return `${base}${encoded}?ref=${CONFIG.branch}`;
}
function ghRawUrl(path){
  const full = CONFIG.rootPath ? `${CONFIG.rootPath}/${path}` : path;
  return `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${full}`;
}

/* -------------------------
   GitHub fetch helper (adds optional token and surfaces API error messages)
   ------------------------- */
async function ghFetch(url, opts = {}){
  const headers = Object.assign({}, opts.headers || {});
  if(CONFIG.token) headers['Authorization'] = `token ${CONFIG.token}`;
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if(!res.ok){
    let msg = `${res.status} ${res.statusText} - ${url}`;
    try{
      const body = await res.json();
      if(body && body.message) msg += `: ${body.message}`;
    }catch(e){}
    throw new Error(`GitHub fetch failed: ${msg}`);
  }
  return res;
}

/* -------------------------
   Fetch tree recursively
   ------------------------- */
async function fetchTree(path=''){
  const url = ghContentsUrl(path);
  const res = await ghFetch(url);
  const items = await res.json();
  const folders = {};
  const files = [];
  for(const item of items){
    if(item.type === 'dir'){
      folders[item.name] = await fetchTree(path ? `${path}/${item.name}` : item.name);
    } else if(item.type === 'file' && item.name.toLowerCase().endsWith('.md')){
      files.push({ name: item.name, path: path ? `${path}/${item.name}` : item.name });
    }
  }
  return { folders, files };
}

/* -------------------------
   Render branch (recursive)
   supports unlimited depth, smooth expand/collapse
   ------------------------- */
function renderBranch(node, container, depth = 0, basePath = ''){
  const folderNames = Object.keys(node.folders).sort();
  folderNames.forEach(folder => {
    const folderWrap = document.createElement('div');
    folderWrap.className = 'branch';
    folderWrap.dataset.path = basePath ? `${basePath}/${folder}` : folder;

    const title = document.createElement('div');
    title.className = 'branch-title';
    title.style.paddingLeft = `${depth * 6}px`;
    title.innerHTML = `📁 ${folder}`;
    folderWrap.appendChild(title);

    const children = document.createElement('div');
    children.className = 'branch-children';
    folderWrap.appendChild(children);

    title.addEventListener('click', () => {
      const open = children.classList.toggle('open');
      collapseSiblings(children, folderWrap.parentElement);
    });

    container.appendChild(folderWrap);
    renderBranch(node.folders[folder], children, depth + 1, folderWrap.dataset.path);
  });

  node.files.sort((a,b)=>a.name.localeCompare(b.name)).forEach(file => {
    const fileEl = document.createElement('div');
    fileEl.className = 'note-link';
    fileEl.style.paddingLeft = `${depth * 6}px`;
    fileEl.textContent = file.name.replace(/\.md$/,'');
    fileEl.dataset.path = file.path;
    fileEl.addEventListener('click', () => loadNote(file.path));
    container.appendChild(fileEl);
  });
}

/* collapse siblings helper */
function collapseSiblings(currentChildren, parent){
  if(!parent) return;
  parent.querySelectorAll('.branch-children').forEach(ch => {
    if(ch !== currentChildren) ch.classList.remove('open');
  });
}

/* -------------------------
   Render subjects (top-level)
   ------------------------- */
function renderSubjects(tree){
  subjectsDropdown.innerHTML = `<div class="subject-header">Subjects</div>`;
  const topFolders = Object.keys(tree.folders).sort();
  topFolders.forEach((subject, idx) => {
    const branch = document.createElement('div');
    branch.className = 'branch';
    const title = document.createElement('div');
    title.className = 'branch-title';
    title.innerHTML = `📁 ${subject}`;
    branch.appendChild(title);

    const children = document.createElement('div');
    children.className = 'branch-children';
    branch.appendChild(children);

    title.addEventListener('click', () => {
      const open = children.classList.toggle('open');
      collapseSiblings(children, subjectsDropdown);
    });

    subjectsDropdown.appendChild(branch);
    renderBranch(state.tree.folders[subject], children, 0, subject);

    if(idx === 0) children.classList.add('open');
  });
}

/* -------------------------
   Process callouts (Obsidian-style > [!TYPE])
   Converts blockquotes or any block-level element starting with [!TYPE] into styled callout divs
   ------------------------- */
function processCallouts(container){
  // Icons for common types (unknown types use a default)
  const icons = {
    note: '📝', warning: '⚠️', danger: '🚨', error: '❌', tip: '💡', hint: '💡',
    example: '📋', quote: '💬', info: 'ℹ️', abstract: '📋', summary: '📋',
    bug: '🐛', failure: '❌', success: '✅'
  };

  function sanitizeType(raw){
    return raw.toLowerCase().trim().replace(/[^a-z0-9_-]+/g,'-');
  }
  function displayTitle(raw){
    raw = raw.trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  function removeMarkerFromNode(node){
    if(!node) return false;
    // Text node
    if(node.nodeType === Node.TEXT_NODE){
      const txt = node.nodeValue || '';
      if(/^\s*\[!.+?\]\s*/i.test(txt)){
        node.nodeValue = txt.replace(/^\s*\[!.+?\]\s*/i, '');
        return true;
      }
      return false;
    }
    // Element node: check children in order
    if(node.nodeType === Node.ELEMENT_NODE){
      const children = Array.from(node.childNodes);
      for(const child of children){
        if(removeMarkerFromNode(child)){
          // remove empty elements left behind
          if(child.nodeType === Node.ELEMENT_NODE && !child.textContent.trim()) child.remove();
          return true;
        }
      }
    }
    return false;
  }

  // Helper to build callout and replace an element
  function makeCalloutFor(el, typeRaw){
    const type = sanitizeType(typeRaw);
    const calloutDiv = document.createElement('div');
    calloutDiv.className = `callout ${type}`;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'callout-title';
    titleDiv.innerHTML = `<span class="callout-icon">${icons[type] || '📌'}</span><span>${displayTitle(typeRaw)}</span>`;

    // Remove marker from the element/content
    removeMarkerFromNode(el);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'callout-content';
    contentDiv.innerHTML = el.innerHTML;

    calloutDiv.appendChild(titleDiv);
    calloutDiv.appendChild(contentDiv);

    el.parentNode.replaceChild(calloutDiv, el);
  }

  // 1) Process blockquotes (standard markdown '>' -> <blockquote>)
  const blockquotes = Array.from(container.querySelectorAll('blockquote'));
  blockquotes.forEach(bq => {
    const bqText = bq.textContent || '';
    const match = bqText.match(/^\s*\[!(.+?)\]/i);
    if(!match) return;
    makeCalloutFor(bq, match[1]);
  });

  // 2) Also process other block-level elements that may contain the marker (robustness)
  const blockTags = ['p','div','li','pre','section','article','figure','aside','header','footer'];
  const candidates = Array.from(container.querySelectorAll(blockTags.join(',')));
  candidates.forEach(el => {
    if(el.closest('blockquote')) return; // already handled
    const txt = el.textContent || '';
    const match = txt.match(/^\s*\[!(.+?)\]/i);
    if(!match) return;
    makeCalloutFor(el, match[1]);
  });
}

/* -------------------------
   Load note, update UI, breadcrumbs, recent
   ------------------------- */
async function loadNote(path){
  try{
    statusEl.textContent = 'Loading…';
    const res = await ghFetch(ghRawUrl(path));
    const text = await res.text();

    const title = path.split('/').pop().replace(/\.md$/,'');
    const topic = path.split('/')[0] || 'Notes';

    noteTitleEl.textContent = title;
    noteTopicEl.textContent = topic;
    noteInfoEl.textContent = path;
    currentPathEl.textContent = path;
    noteContentEl.innerHTML = marked.parse(text);

    // Process callouts (Obsidian-style > [!TYPE])
    processCallouts(noteContentEl);

    // Render LaTeX (KaTeX auto-render) if available. Delimiters: $$...$$ (display) and $...$ (inline)
    try{
      if(window.renderMathInElement){
        renderMathInElement(noteContentEl, {
          delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
          ],
          throwOnError: false
        });
      }
    }catch(e){ console.warn('KaTeX render failed', e); }

    state.currentNote = { path, title, content: text };

    setURL(path);
    updateBreadcrumbs(path);
    addRecent(path);

    // render mermaid diagrams inside the rendered markdown
    await renderAllMermaid();

    statusEl.textContent = 'Loaded';
  }catch(err){
    console.error(err);
    statusEl.textContent = 'Error loading note';
  }
}


/* -------------------------
   Mermaid rendering
   - finds <pre><code class="language-mermaid">...</code></pre>
   - replaces with rendered SVG using mermaid.mermaidAPI.render
   ------------------------- */
let mermaidIdCounter = 0;
/* -------------------------
   Mermaid rendering (modern API)
   ------------------------- */
async function renderAllMermaid() {
  if (!window.mermaid) return;

  const blocks = noteContentEl.querySelectorAll(
    'pre code.language-mermaid, code.language-mermaid'
  );

  for (const block of blocks) {
    const code = block.textContent.trim();
    const id = "mmd-" + Math.random().toString(36).slice(2);

    try {
      const { svg } = await mermaid.render(id, code);

      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-svg";
      wrapper.innerHTML = svg;

      const pre = block.closest("pre");
      if (pre) pre.replaceWith(wrapper);
      else block.replaceWith(wrapper);

    } catch (err) {
      console.error("Mermaid render error:", err);

      const errorBox = document.createElement("div");
      errorBox.style.color = "crimson";
      errorBox.style.margin = "0.5rem 0";
      errorBox.textContent = "Mermaid diagram failed to render.";
      block.closest("pre")?.after(errorBox);
    }
  }
}


/* -------------------------
   Breadcrumbs
   ------------------------- */
function updateBreadcrumbs(path){
  if(!path){
    breadcrumbsEl.style.display = 'none';
    return;
  }
  breadcrumbsEl.style.display = 'flex';
  breadcrumbsEl.innerHTML = '';
  const parts = path.split('/');
  let accum = [];
  parts.forEach((p, i) => {
    accum.push(p);
    const seg = accum.join('/');
    const label = p.replace(/\.md$/,'');
    const a = document.createElement('a');
    a.textContent = label;
    a.href = 'javascript:void(0)';
    a.addEventListener('click', () => {
      expandPath(seg);
      if(seg.toLowerCase().endsWith('.md')) loadNote(seg);
    });
    breadcrumbsEl.appendChild(a);
    if(i < parts.length - 1){
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      breadcrumbsEl.appendChild(sep);
    }
  });
}

/* Expand sidebar nodes matching a path (open branches along path) */
function expandPath(path){
  const segments = path.split('/');
  let current = '';
  segments.forEach((seg, idx) => {
    current = current ? `${current}/${seg}` : seg;
    const branch = document.querySelector(`.branch[data-path="${current}"]`);
    if(branch){
      const children = branch.querySelector('.branch-children');
      if(children) children.classList.add('open');
    }
  });
  document.querySelectorAll('.branch-children').forEach(ch => {
    const parentBranch = ch.parentElement;
    if(parentBranch && parentBranch.dataset.path){
      const p = parentBranch.dataset.path;
      if(!path.startsWith(p)) ch.classList.remove('open');
    }
  });
}

/* -------------------------
   Recent notes (localStorage)
   ------------------------- */
const RECENT_KEY = 'opennotes_recent';
function getRecent(){
  try{ const raw = localStorage.getItem(RECENT_KEY); return raw ? JSON.parse(raw) : []; }catch{ return []; }
}
function saveRecent(list){ try{ localStorage.setItem(RECENT_KEY, JSON.stringify(list)); }catch{} }
function addRecent(path){
  if(!path) return;
  const list = getRecent().filter(p => p !== path);
  list.unshift(path);
  if(list.length > 12) list.length = 12;
  saveRecent(list);
  renderRecent();
}
function renderRecent(){
  const list = getRecent();
  recentListEl.innerHTML = '';
  if(!list.length){
    recentListEl.innerHTML = '<div style="color:var(--muted)">No recent notes yet — open a note to add it here.</div>';
    return;
  }
  list.forEach(p => {
    const el = document.createElement('div');
    el.className = 'recent-item';
    el.textContent = p;
    el.addEventListener('click', () => loadNote(p));
    recentListEl.appendChild(el);
  });
}

/* -------------------------
   Build search index (loads all notes once)
   ------------------------- */
async function buildIndex(node){
  for(const file of node.files){
    try{
      const res = await fetch(ghRawUrl(file.path));
      if(!res.ok) continue;
      const text = await res.text();
      state.notesIndex.push({ path: file.path, title: file.name.replace(/\.md$/,''), content: text.toLowerCase() });
    }catch(e){
      console.warn('Index fetch failed for', file.path);
    }
  }
  for(const folder in node.folders){
    await buildIndex(node.folders[folder]);
  }
}

/* -------------------------
   Search UI
   ------------------------- */
function runSearch(q){
  q = q.toLowerCase().trim();
  if(!q){ searchResultsEl.style.display = 'none'; searchResultsEl.innerHTML = ''; return; }
  const results = state.notesIndex.filter(n => n.title.toLowerCase().includes(q) || n.content.includes(q)).slice(0,50);
  searchResultsEl.innerHTML = '';
  if(!results.length){
    const none = document.createElement('div'); none.className = 'search-result-item'; none.textContent = `No results for "${q}"`; searchResultsEl.appendChild(none);
    searchResultsEl.style.display = 'block'; return;
  }
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.textContent = r.path;
    item.addEventListener('click', () => { searchResultsEl.style.display = 'none'; loadNote(r.path); });
    searchResultsEl.appendChild(item);
  });
  searchResultsEl.style.display = 'block';
}

/* -------------------------
   Keyboard shortcuts & events
   ------------------------- */
document.addEventListener('keydown', e => {
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); searchInput.focus(); }
  if(e.key.toLowerCase() === 'n' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA'){ e.preventDefault(); createNotePlaceholder(); }
});
searchInput.addEventListener('input', e => runSearch(e.target.value));
searchInput.addEventListener('blur', () => setTimeout(()=>{ searchResultsEl.style.display='none'; }, 150));

/* -------------------------
   Share button
   ------------------------- */
shareBtn.addEventListener('click', () => {
  if(!state.currentNote) return;
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const prev = statusEl.textContent;
    statusEl.textContent = 'Link copied!';
    setTimeout(()=> statusEl.textContent = prev, 1400);
  });
});

/* -------------------------
   Placeholder create note (hook)
   ------------------------- */
function createNotePlaceholder(){
  alert('Create note flow — integrate your editor here.');
}

/* -------------------------
   Init: fetch tree, render, index, load URL note or show recent
   ------------------------- */
(async function init(){
  try{
    statusEl.textContent = 'Fetching vault…';
    const tree = await fetchTree('');
    state.tree = tree;
    renderSubjects(tree);

    statusEl.textContent = 'Indexing notes…';
    await buildIndex(tree);
    statusEl.textContent = `Ready · ${state.notesIndex.length} notes indexed`;

    renderRecent();

    const urlNote = getURLNote();
    if(urlNote){
      expandPath(urlNote);
      await loadNote(urlNote);
    } else {
      currentPathEl.textContent = 'Recent';
    }
  }catch(err){
    console.error(err);
    statusEl.textContent = 'Error loading vault';
    noteContentEl.innerHTML = `<p style="color:var(--muted)">Could not load repository. Check <code>CONFIG</code>, that the repo is public, and that the branch exists. Error: ${err.message}</p>`;
  }
})();
