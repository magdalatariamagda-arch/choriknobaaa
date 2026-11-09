import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

const isConfigured = SUPABASE_URL.startsWith('https://')
  && !SUPABASE_URL.includes('YOUR_PROJECT')
  && SUPABASE_ANON_KEY.length > 20
  && !SUPABASE_ANON_KEY.includes('YOUR_');
const page = document.body.dataset.page || 'feed';
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const formatDate = (value) => new Intl.DateTimeFormat('ka-GE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
let supabase = null;
let session = null;
let previewUrl = null;
let feedChannel = null;
let refreshTimeout = null;

function showMessage(element, message, kind = '') {
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
}

function setupNotice() {
  document.querySelectorAll('#setupNotice').forEach((notice) => { notice.hidden = false; });
  const uploadHint = document.getElementById('uploadSetupHint');
  if (uploadHint) uploadHint.hidden = false;
  const authRequired = document.getElementById('authRequired');
  if (authRequired) authRequired.hidden = true;
  const publishButton = document.querySelector('#postForm [type="submit"]');
  const showUploadConfigurationError = (event) => {
    event.preventDefault();
    showMessage(
      document.getElementById('uploadMessage'),
      'ფოტო ვერ გამოქვეყნდება: Supabase-ის Project URL და anon/public key ჯერ არ არის მითითებული. შეავსე supabase-config.js და გაუშვი README-ში აღწერილი SQL დაყენება.',
      'error'
    );
  };
  publishButton?.addEventListener('click', showUploadConfigurationError);
  document.querySelectorAll('[data-auth-form] button[type="submit"]').forEach((button) => { button.disabled = true; });
  document.querySelectorAll('form').forEach((form) => {
    if (form.id !== 'postForm' && !form.matches('[data-auth-form]')) {
      form.addEventListener('submit', (event) => event.preventDefault());
    }
  });
  const feedStatus = document.getElementById('feedStatus');
  if (feedStatus) showMessage(feedStatus, 'საერთო ლენტის ჩასატვირთად Supabase-ის კონფიგურაციაა საჭირო.', 'error');
  const uploadStatus = document.getElementById('uploadMessage');
  if (uploadStatus) showMessage(uploadStatus, 'ფოტოს არჩევა და preview მუშაობს; გამოქვეყნება Supabase-ის URL-ისა და public key-ის დამატების შემდეგ გააქტიურდება.', 'error');
}

async function updateAccountUI() {
  document.querySelectorAll('[data-auth-email]').forEach((element) => {
    element.textContent = session?.user ? 'ანონიმი' : 'სტუმარი';
  });
  document.querySelectorAll('[data-account-link]').forEach((link) => {
    link.href = session?.user ? 'account.html' : 'auth.html#login';
  });
  document.querySelectorAll('[data-account-label]').forEach((element) => {
    element.textContent = session?.user ? 'ჩემი ანგარიში' : 'შესვლა / რეგისტრაცია';
  });
  const publishButton = document.querySelector('#postForm [type="submit"]');
  if (publishButton && supabase) publishButton.disabled = !session?.user;
  const authRequired = document.getElementById('authRequired');
  if (authRequired) authRequired.hidden = !supabase || Boolean(session?.user);
  const adminLinks = document.querySelectorAll('[data-admin-link]');
  adminLinks.forEach((element) => { element.hidden = true; });
  if (session?.user && supabase && adminLinks.length) {
    const { data: isAdmin, error } = await supabase.rpc('is_admin');
    if (error) console.error('Admin role lookup failed:', error);
    adminLinks.forEach((element) => { element.hidden = isAdmin !== true; });
  }
}

async function validateImage(file) {
  if (!file) throw new Error('ასატვირთად ფოტო აირჩიე.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('ფოტოს ზომა 5 მბ-ს არ უნდა აღემატებოდეს.');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let contentType = '';
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) contentType = 'image/jpeg';
  else if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) contentType = 'image/png';
  else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
    && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) contentType = 'image/webp';
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) throw new Error('ფაილი დაზიანებულია ან მხარდაჭერილი ფორმატის არ არის. გამოიყენე JPG, JPEG, PNG ან WebP.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('ფოტოს გახსნა ვერ მოხერხდა. აირჩიე სხვა სურათი.');
  }
  const valid = bitmap.width >= 128 && bitmap.height >= 128 && bitmap.width <= 12000 && bitmap.height <= 12000;
  bitmap.close();
  if (!valid) throw new Error('ფოტო უნდა იყოს მინიმუმ 128×128 და მაქსიმუმ 12000×12000 პიქსელი.');
  return contentType;
}

function bindImagePicker() {
  const input = document.querySelector('#postForm input[type="file"]');
  if (!input) return;
  input.addEventListener('change', async () => {
    const preview = document.getElementById('imagePreview') || document.getElementById('photoPreview');
    const message = document.getElementById('uploadMessage') || document.getElementById('formMessage');
    const previewBox = document.getElementById('previewBox');
    if (!preview) return;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await validateImage(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      preview.hidden = false;
      preview.classList.remove('hidden');
      if (previewBox) {
        previewBox.hidden = false;
        previewBox.classList.remove('hidden');
      }
      const uploadLabel = document.getElementById('uploadLabel');
      if (uploadLabel) uploadLabel.textContent = file.name;
      showMessage(message, 'ფოტო მზადაა გამოსაქვეყნებლად.');
    } catch (error) {
      input.value = '';
      preview.hidden = true;
      preview.classList.add('hidden');
      preview.removeAttribute('src');
      if (previewBox) {
        previewBox.hidden = true;
        previewBox.classList.add('hidden');
      }
      const uploadLabel = document.getElementById('uploadLabel');
      if (uploadLabel) uploadLabel.textContent = 'აირჩიე ფოტო';
      showMessage(message, error.message, 'error');
    }
  });

  document.getElementById('removePhoto')?.addEventListener('click', () => {
    input.value = '';
    const preview = document.getElementById('imagePreview') || document.getElementById('photoPreview');
    preview?.removeAttribute('src');
    if (preview) { preview.hidden = true; preview.classList.add('hidden'); }
    const previewBox = document.getElementById('previewBox');
    if (previewBox) { previewBox.hidden = true; previewBox.classList.add('hidden'); }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    const label = document.getElementById('uploadLabel');
    if (label) label.textContent = 'აირჩიე ფოტო';
  });
}

async function getImageUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return supabase.storage.from('post-images').getPublicUrl(path).data.publicUrl;
}

async function loadFeed() {
  if (!supabase) return;
  const modernFeed = document.getElementById('postsList');
  const homeFeed = document.getElementById('postsFeed');
  const feed = modernFeed || homeFeed;
  if (!feed) return;
  const status = document.getElementById('feedStatus');
  if (status) showMessage(status, 'ლენტა იტვირთება...');
  const { data: posts, error } = await supabase.from('public_feed')
    .select('id,image_path,caption,created_at,can_delete,likes_count,comments_count,comments')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Feed request failed:', error);
    if (status) showMessage(status, 'პოსტები ვერ ჩაიტვირთა. შეამოწმე Supabase SQL კონფიგურაცია და public_feed view.', 'error');
    return;
  }
  if (status) showMessage(status, `${posts.length} პოსტი`);
  const empty = document.getElementById('emptyState');
  if (empty) empty.hidden = posts.length > 0;
  const liked = new Set();
  const saved = new Set();
  if (session?.user && posts.length) {
    const ids = posts.map((post) => post.id);
    const [likesResult, savedResult] = await Promise.all([
      supabase.from('likes').select('post_id').in('post_id', ids),
      supabase.from('saved_posts').select('post_id').in('post_id', ids)
    ]);
    (likesResult.data || []).forEach((row) => liked.add(row.post_id));
    (savedResult.data || []).forEach((row) => saved.add(row.post_id));
  }
  const imageUrls = await Promise.all(posts.map((post) => getImageUrl(post.image_path)));
  if (modernFeed) {
    modernFeed.innerHTML = posts.map((post, index) => renderModernPost(post, imageUrls[index], liked, saved)).join('');
  } else {
    homeFeed.innerHTML = posts.map((post, index) => renderHomePost(post, imageUrls[index])).join('');
  }
}

function renderModernPost(post, imageUrl, liked, saved) {
  const comments = Array.isArray(post.comments) ? post.comments : [];
  return `<article class="feed-post" data-post-id="${escapeHtml(post.id)}">
    <header class="post-topline"><span class="post-avatar">ა</span><div class="post-author"><strong>ანონიმი</strong><time>${escapeHtml(formatDate(post.created_at))}</time></div>
      <div class="post-header-actions">${post.can_delete ? `<button class="icon-button delete-post" data-post-id="${escapeHtml(post.id)}" aria-label="პოსტის წაშლა">⌫</button>` : ''}<button class="icon-button report-open" data-report-target="post" data-post-id="${escapeHtml(post.id)}" aria-label="გასაჩივრება">⚑</button></div></header>
    <img class="feed-photo" src="${escapeHtml(imageUrl)}" alt="ანონიმური მომხმარებლის ფოტო" loading="lazy">
    <div class="post-controls"><div class="post-controls-left"><button class="icon-button like-button ${liked.has(post.id) ? 'is-liked' : ''}" data-post-id="${escapeHtml(post.id)}" ${session?.user ? '' : 'disabled'} aria-label="მოწონება">♥</button><a class="icon-button comment-jump" href="#comment-${escapeHtml(post.id)}" aria-label="კომენტარები">▱</a><button class="icon-button report-open" data-report-target="post" data-post-id="${escapeHtml(post.id)}" aria-label="გასაჩივრება">⚑</button></div><button class="icon-button save-button ${saved.has(post.id) ? 'is-saved' : ''}" data-post-id="${escapeHtml(post.id)}" ${session?.user ? '' : 'disabled'} aria-label="შენახვა">▮</button></div>
    <p class="like-count">${Number(post.likes_count) || 0} მოწონება</p><p class="post-caption"><strong>ანონიმი</strong> ${escapeHtml(post.caption || '')}</p>
    <button class="comments-count" type="button" data-scroll-to="comment-${escapeHtml(post.id)}">ყველა კომენტარი (${Number(post.comments_count) || comments.length})</button>
    <ul class="post-comments">${comments.map((comment) => `<li class="comment-row"><span class="comment-anon">ა</span><p><strong>ანონიმი</strong> ${escapeHtml(comment.body)}</p>${comment.can_delete ? `<button class="icon-button delete-comment" data-comment-id="${escapeHtml(comment.id)}" aria-label="კომენტარის წაშლა">×</button>` : ''}</li>`).join('')}</ul>
    <form class="comment-form" id="comment-${escapeHtml(post.id)}" data-post-id="${escapeHtml(post.id)}"><input name="body" maxlength="500" placeholder="დაწერე ანონიმური კომენტარი..." required ${session?.user ? '' : 'disabled'}><button type="submit" ${session?.user ? '' : 'disabled'}>გამოქვეყნება</button></form></article>`;
}

function renderHomePost(post, imageUrl) {
  const comments = Array.isArray(post.comments) ? post.comments : [];
  return `<article class="post" data-post-id="${escapeHtml(post.id)}"><div class="post-header"><div class="post-author"><span class="avatar">ა</span><div><div class="author-name">ანონიმი</div><div class="post-date">${escapeHtml(formatDate(post.created_at))}</div></div></div>${post.can_delete ? `<button class="delete-post" data-post-id="${escapeHtml(post.id)}">წაშლა</button>` : ''}</div>
    ${post.caption ? `<p class="post-text">${escapeHtml(post.caption)}</p>` : ''}<img class="post-photo" src="${escapeHtml(imageUrl)}" alt="ანონიმური პოსტი">
    <div class="post-actions"><button class="home-like" data-post-id="${escapeHtml(post.id)}" ${session?.user ? '' : 'disabled'}>♥ ${Number(post.likes_count) || 0}</button><span>${Number(post.comments_count) || comments.length} კომენტარი</span><button class="report-open" data-report-target="post" data-post-id="${escapeHtml(post.id)}">გასაჩივრება</button></div>
    <div class="comment-area"><div class="comment-title">კომენტარები</div><div class="comment-list">${comments.map((comment) => `<div class="comment"><div class="comment-top"><span class="comment-author">ანონიმი</span>${comment.can_delete ? `<button class="delete-comment" data-comment-id="${escapeHtml(comment.id)}">წაშლა</button>` : ''}</div>${escapeHtml(comment.body)}</div>`).join('')}</div><form class="comment-form" data-post-id="${escapeHtml(post.id)}"><input class="comment-input" name="body" maxlength="500" placeholder="დაწერე ანონიმური კომენტარი..." required ${session?.user ? '' : 'disabled'}><button class="comment-submit" type="submit" ${session?.user ? '' : 'disabled'}>გაგზავნა</button></form></div></article>`;
}

function subscribeToFeed() {
  if (!supabase || feedChannel) return;
  feedChannel = supabase.channel('feed-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'feed_events' }, () => {
      clearTimeout(refreshTimeout);
      refreshTimeout = setTimeout(loadFeed, 200);
    }).subscribe();
}

async function publishPost(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fileInput = form.querySelector('input[type="file"]');
  const file = fileInput?.files?.[0];
  const caption = (form.querySelector('[name="caption"]') || document.getElementById('postText'))?.value.trim() || '';
  const message = document.getElementById('uploadMessage') || document.getElementById('formMessage');
  const button = form.querySelector('[type="submit"]');
  if (!supabase) {
    showMessage(message, 'ფოტო ვერ გამოქვეყნდება: Supabase-ის Project URL და anon/public key ჯერ არ არის მითითებული. შეავსე supabase-config.js და გაუშვი README-ში აღწერილი SQL დაყენება.', 'error');
    return;
  }
  if (!session?.user) {
    showMessage(message, 'ფოტოს გამოსაქვეყნებლად ჯერ შედი ანგარიშში.', 'error');
    return;
  }
  let path = '';
  try {
    const contentType = await validateImage(file);
    button.disabled = true;
    showMessage(message, 'ფოტო იტვირთება საცავში...');
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    path = `${crypto.randomUUID()}.${extension}`;
    const { error: storageError } = await supabase.storage.from('post-images').upload(path, file, { contentType, upsert: false, cacheControl: '3600' });
    if (storageError) throw Object.assign(storageError, { stage: 'storage' });
    showMessage(message, 'ფოტო აიტვირთა; ვინახავ პოსტს...');
    const { error: postError } = await supabase.from('posts').insert({ author_id: session.user.id, image_path: path, caption });
    if (postError) throw Object.assign(postError, { stage: 'database' });
    form.reset();
    const preview = document.getElementById('imagePreview') || document.getElementById('photoPreview');
    if (preview) { preview.hidden = true; preview.classList.add('hidden'); preview.removeAttribute('src'); }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    showMessage(message, 'პოსტი გამოქვეყნდა და საერთო ლენტაში დაემატა.');
    await loadFeed();
  } catch (error) {
    console.error('Post publishing failed:', error);
    if (path && error.stage === 'database') {
      const { error: cleanupError } = await supabase.storage.from('post-images').remove([path]);
      if (cleanupError) console.error('Orphan image cleanup failed:', cleanupError);
    }
    showMessage(message, friendlyUploadError(error), 'error');
  } finally {
    if (button) button.disabled = !session?.user;
  }
}

function friendlyUploadError(error) {
  const detail = `${error?.message || ''} ${error?.code || ''} ${error?.statusCode || ''}`.toLowerCase();
  if (error?.message?.startsWith('ფოტო') || error?.message?.startsWith('არჩეული')) return error.message;
  if (detail.includes('row-level security') || detail.includes('42501') || detail.includes('unauthorized')) return 'ატვირთვის უფლება უარყოფილია. შედი ანგარიშში და გადაამოწმე Storage-ის RLS წესები.';
  if (detail.includes('bucket') || detail.includes('not found') || detail.includes('404')) return 'post-images საცავი ვერ მოიძებნა. გაუშვი supabase.sql.';
  if (detail.includes('413') || detail.includes('too large') || detail.includes('payload')) return 'ფოტოს ზომა 5 მბ-ს აღემატება.';
  if (detail.includes('42p01') || detail.includes('pgrst205') || detail.includes('schema cache')) return 'posts ცხრილი ვერ მოიძებნა. გაუშვი supabase.sql და გადაამოწმე schema.';
  if (detail.includes('posting rate')) return 'ერთ წუთში პოსტების ლიმიტს მიაღწიე.';
  if (error?.stage === 'database') return `ფოტო აიტვირთა, მაგრამ პოსტის ჩანაწერი ვერ შეიქმნა: ${error.message || 'შეამოწმე posts ცხრილის სვეტები და RLS.'}`;
  if (error?.stage === 'storage') return `ფოტო საცავში ვერ აიტვირთა: ${error.message || 'შეამოწმე bucket-ის პარამეტრები.'}`;
  return error?.message || 'გამოქვეყნება ვერ მოხერხდა. შეამოწმე ინტერნეტი და Supabase-ის კონფიგურაცია.';
}

async function handleComment(event) {
  if (!event.target.matches('.comment-form')) return;
  event.preventDefault();
  if (!session?.user) return location.assign('auth.html#login');
  const form = event.target;
  const body = new FormData(form).get('body')?.toString().trim();
  if (!body) return;
  const button = form.querySelector('button');
  button.disabled = true;
  const { error } = await supabase.from('comments').insert({ post_id: form.dataset.postId, author_id: session.user.id, body });
  if (error) { button.disabled = false; return alert(error.message.includes('Duplicate') ? 'იგივე კომენტარი ახლახან უკვე დაწერე.' : 'კომენტარი ვერ გამოქვეყნდა. გადაამოწმე ავტორიზაცია და comments RLS.'); }
  await loadFeed();
}

async function handleFeedClick(event) {
  const deletePost = event.target.closest('.delete-post');
  if (deletePost) return removePost(deletePost);
  const deleteComment = event.target.closest('.delete-comment');
  if (deleteComment) return removeComment(deleteComment);
  const like = event.target.closest('.like-button, .home-like');
  if (like) return toggleLike(like);
  const report = event.target.closest('.report-open');
  if (report) return openReport(report.dataset.reportTarget, report.dataset.postId);
}

async function toggleLike(button) {
  if (!session?.user) return location.assign('auth.html#login');
  const postId = button.dataset.postId;
  const found = await supabase.from('likes').select('post_id').eq('post_id', postId).eq('user_id', session.user.id).maybeSingle();
  const result = found.data
    ? await supabase.from('likes').delete().eq('post_id', postId).eq('user_id', session.user.id)
    : await supabase.from('likes').insert({ post_id: postId, user_id: session.user.id });
  if (result.error) return alert('მოწონება ვერ განახლდა. გადაამოწმე likes RLS წესი.');
  await loadFeed();
}

async function removePost(button) {
  if (!confirm('წაიშალოს პოსტი და მასთან დაკავშირებული კომენტარები?')) return;
  const { data: path, error } = await supabase.rpc('delete_post', { target_post_id: button.dataset.postId });
  if (error) return alert(error.code === '42501' ? 'ამ პოსტის წაშლის უფლება არ გაქვს.' : `პოსტი ვერ წაიშალა: ${error.message}`);
  if (path && !/^https?:\/\//i.test(path)) {
    const { error: storageError } = await supabase.storage.from('post-images').remove([path]);
    if (storageError) console.error('Storage cleanup failed:', storageError);
  }
  await loadFeed();
}

async function removeComment(button) {
  if (!confirm('წაიშალოს ეს კომენტარი?')) return;
  const { error } = await supabase.rpc('delete_comment', { target_comment_id: button.dataset.commentId });
  if (error) return alert(error.code === '42501' ? 'ამ კომენტარის წაშლის უფლება არ გაქვს.' : `კომენტარი ვერ წაიშალა: ${error.message}`);
  await loadFeed();
}

function openReport(targetType, targetId) {
  if (!session?.user) return location.assign('auth.html#login');
  const dialog = document.getElementById('reportDialog');
  if (!dialog) return;
  dialog.elements.targetType.value = targetType;
  dialog.elements.targetId.value = targetId;
  dialog.showModal();
}

async function submitReport(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const { error } = await supabase.from('reports').insert({ reporter_id: session.user.id, target_type: formData.get('targetType'), target_id: formData.get('targetId'), reason: formData.get('reason') });
  if (error) return showMessage(document.getElementById('reportMessage'), 'შეტყობინება ვერ გაიგზავნა. სცადე მოგვიანებით.', 'error');
  document.getElementById('reportDialog').close();
}

function bindAuthTabs() {
  const login = document.getElementById('loginTab');
  const register = document.getElementById('registerTab');
  const loginPanel = document.getElementById('loginPanel');
  const registerPanel = document.getElementById('registerPanel');
  if (!login || !register || !loginPanel || !registerPanel) return;
  const select = (mode) => {
    const registering = mode === 'register';
    loginPanel.classList.toggle('hidden', registering);
    registerPanel.classList.toggle('hidden', !registering);
    login.classList.toggle('active', !registering);
    register.classList.toggle('active', registering);
    login.setAttribute('aria-selected', String(!registering));
    register.setAttribute('aria-selected', String(registering));
    history.replaceState(null, '', registering ? '#register' : '#login');
  };
  login.addEventListener('click', () => select('login'));
  register.addEventListener('click', () => select('register'));
  select(location.hash === '#register' ? 'register' : 'login');
}

async function handleAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const email = String(data.get('email') || '').trim().toLowerCase();
  const password = String(data.get('password') || '');
  const message = document.getElementById('authMessage');
  if (form.dataset.mode === 'register') {
    if (password.length < 10) return showMessage(message, 'პაროლი მინიმუმ 10 სიმბოლოს უნდა შეიცავდეს.', 'error');
    if (password !== data.get('password-confirm')) return showMessage(message, 'პაროლები ერთმანეთს არ ემთხვევა.', 'error');
    const { data: result, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
    if (error) return showMessage(message, 'რეგისტრაცია ვერ შესრულდა. გადაამოწმე ელფოსტა და Supabase Auth-ის პარამეტრები.', 'error');
    if (result.session) location.assign('account.html');
    else showMessage(message, 'ანგარიში შეიქმნა. შეამოწმე ელფოსტა და დაადასტურე ანგარიში.');
    return;
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return showMessage(message, 'შესვლა ვერ მოხერხდა. გადაამოწმე ელფოსტა, პაროლი და ანგარიშის დადასტურება.', 'error');
  location.assign('account.html');
}

async function loadAccount() {
  if (!session?.user) return location.replace('auth.html#login');
  const { data: profile, error } = await supabase.from('profiles').select('is_blocked,created_at').single();
  if (error) {
    showMessage(document.getElementById('accountStatus'), 'ანგარიშის მონაცემები ვერ ჩაიტვირთა. გადაამოწმე profiles RLS კონფიგურაცია.', 'error');
    console.error('Profile load failed:', error);
    return;
  }
  document.getElementById('accountEmail').textContent = session.user.email || 'ელფოსტა მიუწვდომელია';
  document.getElementById('accountCreated').textContent = formatDate(profile.created_at);
  document.getElementById('blockedNotice').hidden = !profile.is_blocked;
  document.querySelectorAll('[data-account-action]').forEach((control) => { control.disabled = profile.is_blocked; });
}

async function loadAdmin() {
  const denied = document.getElementById('adminDenied');
  const dashboard = document.getElementById('adminDashboard');
  const { data: isAdmin, error: roleError } = await supabase.rpc('is_admin');
  if (roleError || isAdmin !== true) {
    if (denied) denied.hidden = false;
    if (dashboard) dashboard.hidden = true;
    return;
  }
  denied.hidden = true;
  dashboard.hidden = false;

  const results = await Promise.all([
    supabase.from('admin_posts').select('*').order('created_at', { ascending: false }),
    supabase.from('admin_comments').select('*').order('created_at', { ascending: false }),
    supabase.from('admin_users').select('*').order('created_at', { ascending: false }),
    supabase.from('admin_reports').select('*').order('created_at', { ascending: false })
  ]);
  if (results.some((result) => result.error)) {
    console.error('Admin data load failed:', results.map((result) => result.error).filter(Boolean));
    showMessage(document.getElementById('adminStatus'), 'ადმინისტრატორის მონაცემები ვერ ჩაიტვირთა. გაუშვი შესაბამისი Supabase SQL migration.', 'error');
    return;
  }
  const [posts, comments, users, reports] = results.map((result) => result.data || []);
  document.getElementById('adminPosts').innerHTML = posts.map((post) => `<article class="admin-row"><div><strong>${escapeHtml(post.author_email || 'სისტემური პოსტი')}</strong><p>${escapeHtml(post.caption || '')}</p><time>${escapeHtml(formatDate(post.created_at))}</time></div><button class="danger-button" data-admin-action="delete-post" data-id="${escapeHtml(post.id)}">წაშლა</button></article>`).join('') || '<p>პოსტები არ არის.</p>';
  document.getElementById('adminComments').innerHTML = comments.map((comment) => `<article class="admin-row"><div><strong>${escapeHtml(comment.author_email)}</strong><p>${escapeHtml(comment.body)}</p><time>${escapeHtml(formatDate(comment.created_at))}</time></div><button class="danger-button" data-admin-action="delete-comment" data-id="${escapeHtml(comment.id)}">წაშლა</button></article>`).join('') || '<p>კომენტარები არ არის.</p>';
  document.getElementById('adminUsers').innerHTML = users.map((user) => `<article class="admin-row"><div><strong>${escapeHtml(user.email)}</strong><p>${escapeHtml(formatDate(user.created_at))}</p></div><button class="danger-button" data-admin-action="toggle-user" data-id="${escapeHtml(user.user_id)}" data-blocked="${user.is_blocked}">${user.is_blocked ? 'განბლოკვა' : 'დაბლოკვა'}</button></article>`).join('') || '<p>მომხმარებლები არ არის.</p>';
  document.getElementById('adminReports').innerHTML = reports.map((report) => `<article class="admin-row"><div><strong>${escapeHtml(report.target_type)} · ${escapeHtml(report.target_author_email || 'ავტორი მიუწვდომელია')}</strong><p>${escapeHtml(report.reason)}</p><time>${escapeHtml(report.status)} · ${escapeHtml(formatDate(report.created_at))}</time></div><div class="admin-actions"><button class="neutral-button" data-admin-action="review-report" data-id="${escapeHtml(report.id)}">განხილულია</button><button class="danger-button" data-admin-action="dismiss-report" data-id="${escapeHtml(report.id)}">დახურვა</button></div></article>`).join('') || '<p>გასაჩივრება არ არის.</p>';
}

async function handleAdminClick(event) {
  const button = event.target.closest('[data-admin-action]');
  if (!button) return;
  const action = button.dataset.adminAction;
  const confirmMessage = action.startsWith('delete') ? 'ნამდვილად გსურს წაშლა?' : action === 'toggle-user' ? 'შეიცვალოს მომხმარებლის წვდომა?' : '';
  if (confirmMessage && !confirm(confirmMessage)) return;
  let result;
  const id = button.dataset.id;
  if (action === 'delete-post') result = await supabase.rpc('delete_post', { target_post_id: id });
  if (action === 'delete-comment') result = await supabase.rpc('delete_comment', { target_comment_id: id });
  if (action === 'toggle-user') result = await supabase.rpc('admin_set_user_block', { target_user_id: id, should_block: button.dataset.blocked !== 'true' });
  if (action === 'review-report') result = await supabase.rpc('admin_review_report', { target_report_id: id, next_status: 'reviewed' });
  if (action === 'dismiss-report') result = await supabase.rpc('admin_review_report', { target_report_id: id, next_status: 'dismissed' });
  if (result?.error) {
    console.error('Admin action failed:', result.error);
    showMessage(document.getElementById('adminStatus'), 'მოქმედება ვერ შესრულდა. გადაამოწმე სერვერის უფლებები.', 'error');
    return;
  }
  await loadAdmin();
}

function bindForms() {
  bindImagePicker();
  bindAuthTabs();
  document.querySelector('#postForm')?.addEventListener('submit', publishPost);
  document.querySelectorAll('[data-auth-form]').forEach((form) => form.addEventListener('submit', handleAuth));
  document.getElementById('postsList')?.addEventListener('submit', handleComment);
  document.getElementById('postsFeed')?.addEventListener('submit', handleComment);
  document.getElementById('postsList')?.addEventListener('click', handleFeedClick);
  document.getElementById('postsFeed')?.addEventListener('click', handleFeedClick);
  document.getElementById('reportForm')?.addEventListener('submit', submitReport);
  document.getElementById('adminDashboard')?.addEventListener('click', handleAdminClick);
  document.getElementById('feedSearch')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLocaleLowerCase('ka');
    document.querySelectorAll('#postsList .feed-post, #postsFeed .post').forEach((post) => { post.hidden = !post.textContent.toLocaleLowerCase('ka').includes(query); });
  });
  document.getElementById('signOutButton')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.assign('index.html');
  });
}

async function initialize() {
  bindForms();
  if (!isConfigured) {
    setupNotice();
    updateAccountUI();
    return;
  }
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    session = data.session;
    await updateAccountUI();
    supabase.auth.onAuthStateChange((_event, nextSession) => {
      session = nextSession;
      updateAccountUI();
      loadFeed();
    });
    await loadFeed();
    subscribeToFeed();
    if (page === 'account') await loadAccount();
    if (page === 'admin') await loadAdmin();
  } catch (error) {
    console.error('App initialization failed:', error);
    document.querySelectorAll('#setupNotice').forEach((notice) => { notice.hidden = false; notice.textContent = 'Supabase-თან დაკავშირება ვერ მოხერხდა. გადაამოწმე ინტერნეტი და პროექტის კონფიგურაცია.'; });
  }
}

document.addEventListener('DOMContentLoaded', initialize);
