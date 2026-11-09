import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Flag,
  ImagePlus,
  LockKeyhole,
  LogIn,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { backendReady, supabase } from "./lib/supabase";
import type { Comment, Post, Report, Topic } from "./types";

const topics: Topic[] = ["ურთიერთობები", "სამსახური", "სწავლა", "ცხოვრება", "სხვა"];
const reasons = ["შეურაცხმყოფელი შინაარსი", "სპამი ან რეკლამა", "მუქარა ან ძალადობა", "სხვა"];
const imageExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function formatTime(value: string) {
  const date = new Date(value);
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "ახლახან";
  if (minutes < 60) return `${minutes} წთ წინ`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} სთ წინ`;
  return date.toLocaleDateString("ka-GE", { day: "numeric", month: "short" });
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [admin, setAdmin] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [adminOpen, setAdminOpen] = useState(false);
  const [activeTopic, setActiveTopic] = useState<Topic | "ყველა" | "პოპულარული">("ყველა");
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [reportTarget, setReportTarget] = useState<{ type: "post" | "comment"; id: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [posting, setPosting] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [postText, setPostText] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<Topic>("ცხოვრება");
  const [search, setSearch] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3600);
  };

  const loadFeed = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("public_posts")
      .select("id, body, topic, image_url, created_at, is_mine")
      .order("created_at", { ascending: false });
    if (error) showNotice("პოსტების ჩატვირთვა ვერ მოხერხდა.");
    else {
      const { data: commentRows, error: commentError } = await supabase
        .from("public_comments")
        .select("id, post_id, parent_id, body, created_at, is_mine")
        .order("created_at", { ascending: true });
      if (commentError) showNotice("კომენტარების ჩატვირთვა ვერ მოხერხდა.");
      const comments = (commentRows ?? []) as Comment[];
      setPosts(((data ?? []) as Omit<Post, "comments">[]).map((post) => ({
        ...post,
        comments: comments.filter((comment) => comment.post_id === post.id),
      })));
    }
    setLoading(false);
  }, []);

  const loadAdminData = useCallback(async () => {
    if (!supabase || !user) return;
    const { data: role } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    setAdmin(Boolean(role));
    const { data: ban } = await supabase
      .from("blocked_users")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    setSuspended(Boolean(ban));
    if (!role) return;

    const { data: reportRows, error } = await supabase.rpc("get_moderation_reports");
    if (error) {
      showNotice("საჩივრების ჩატვირთვა ვერ მოხერხდა.");
      return;
    }
    setReports((reportRows ?? []) as Report[]);
  }, [user]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setUser(data.session?.user ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    void loadFeed();
    const intervalId = window.setInterval(() => void loadFeed(), 20_000);
    return () => window.clearInterval(intervalId);
  }, [loadFeed]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const signOut = async () => {
    await supabase?.auth.signOut();
    setAdmin(false);
    setSuspended(false);
    showNotice("ანგარიშიდან გამოხვედით.");
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) return showNotice("ჯერ Supabase-ის კონფიგურაციაა საჭირო.");
    setAuthBusy(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const result = authMode === "signup"
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    setAuthBusy(false);
    if (result.error) return showNotice(result.error.message);
    if (authMode === "signup" && !result.data.session) {
      showNotice("ანგარიშის დასადასტურებლად ელფოსტა შეამოწმეთ.");
    } else {
      setAuthOpen(false);
      showNotice(authMode === "signup" ? "ანგარიში შეიქმნა." : "კეთილი იყოს თქვენი დაბრუნება.");
    }
  };

  const submitPost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !user) return setAuthOpen(true);
    if (suspended) return showNotice("ანგარიში დროებით შეზღუდულია.");
    if (!postText.trim() && !file) return showNotice("დაწერეთ ტექსტი ან დაამატეთ ფოტო.");
    if (file && (!imageExtensions[file.type] || file.size > 10 * 1024 * 1024)) {
      return showNotice("აირჩიეთ JPG, PNG, WebP, GIF ან AVIF ფოტო 10 მბ-მდე.");
    }
    setPosting(true);
    let imageUrl: string | null = null;
    let uploadedPath: string | null = null;
    if (file) {
      const extension = imageExtensions[file.type];
      const path = `${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("post-images").upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadError) {
        setPosting(false);
        return showNotice("ფოტოს ატვირთვა ვერ მოხერხდა. შეამოწმეთ საცავის კონფიგურაცია.");
      }
      uploadedPath = path;
      imageUrl = supabase.storage.from("post-images").getPublicUrl(path).data.publicUrl;
    }
    const { error } = await supabase.from("posts").insert({
      user_id: user.id,
      body: postText.trim(),
      topic: selectedTopic,
      image_url: imageUrl,
    });
    setPosting(false);
    if (error) {
      if (uploadedPath) await supabase.storage.from("post-images").remove([uploadedPath]);
      return showNotice(error.message.includes("blocked") ? "ანგარიში დროებით შეზღუდულია." : "პოსტის გამოქვეყნება ვერ მოხერხდა.");
    }
    setPostText("");
    setFile(null);
    await loadFeed();
    showNotice("პოსტი გამოქვეყნდა.");
  };

  const submitComment = async (postId: string, body: string) => {
    if (!supabase || !user) return setAuthOpen(true);
    if (suspended) return showNotice("ანგარიში დროებით შეზღუდულია.");
    const { error } = await supabase.from("comments").insert({
      post_id: postId,
      user_id: user.id,
      parent_id: replyTo ? (replyTo.parent_id ?? replyTo.id) : null,
      body: body.trim(),
    });
    if (error) return showNotice(error.message || "კომენტარი ვერ გამოქვეყნდა.");
    setReplyTo(null);
    await loadFeed();
  };

  const deletePost = async (post: Post) => {
    if (!supabase) return;
    const { error } = await supabase.from("posts").delete().eq("id", post.id);
    if (error) return showNotice("პოსტის წაშლა ვერ მოხერხდა.");
    if (post.image_url) {
      const marker = "/storage/v1/object/public/post-images/";
      const path = post.image_url.split(marker)[1];
      if (path) await supabase.storage.from("post-images").remove([decodeURIComponent(path)]);
    }
    await loadFeed();
    await loadAdminData();
    showNotice("პოსტი წაიშალა.");
  };

  const deleteComment = async (commentId: string) => {
    if (!supabase) return;
    const { error } = await supabase.from("comments").delete().eq("id", commentId);
    if (error) return showNotice("კომენტარის წაშლა ვერ მოხერხდა.");
    await loadFeed();
    await loadAdminData();
    showNotice("კომენტარი წაიშალა.");
  };

  const submitReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !user || !reportTarget) return setAuthOpen(true);
    const form = new FormData(event.currentTarget);
    const type = reportTarget.type;
    const { error } = await supabase.from("reports").insert({
      reporter_id: user.id,
      target_type: type,
      post_id: type === "post" ? reportTarget.id : null,
      comment_id: type === "comment" ? reportTarget.id : null,
      reason: String(form.get("reason")),
    });
    setReportTarget(null);
    showNotice(error ? "საჩივრის გაგზავნა ვერ მოხერხდა." : "საჩივარი მოდერატორს გაეგზავნა.");
  };

  const resolveReport = async (report: Report, remove: boolean) => {
    if (!supabase) return;
    if (remove) {
      if (report.target_type === "post" && report.post_id) {
        const { error: deleteError } = await supabase.from("posts").delete().eq("id", report.post_id);
        if (deleteError) return showNotice("პოსტის წაშლა ვერ მოხერხდა.");
        if (report.image_url) {
          const marker = "/storage/v1/object/public/post-images/";
          const path = report.image_url.split(marker)[1];
          if (path) await supabase.storage.from("post-images").remove([decodeURIComponent(path)]);
        }
      } else if (report.comment_id) {
        const { error: deleteError } = await supabase.from("comments").delete().eq("id", report.comment_id);
        if (deleteError) return showNotice("კომენტარის წაშლა ვერ მოხერხდა.");
      }
    }
    const { error } = await supabase.from("reports").update({
      status: remove ? "resolved" : "dismissed",
      reviewed_by: user?.id,
    }).eq("id", report.id);
    if (error) return showNotice("საჩივრის დამუშავება ვერ მოხერხდა.");
    setReports((current) => current.filter((row) => row.id !== report.id));
    await loadFeed();
    showNotice(remove ? "შინაარსი წაიშალა და საჩივარი დაიხურა." : "საჩივარი უარყოფილია.");
  };

  const toggleBan = async (accountId: string) => {
    if (!supabase) return;
    const alreadyBlocked = await supabase.from("blocked_users").select("user_id").eq("user_id", accountId).maybeSingle();
    const result = alreadyBlocked.data
      ? await supabase.from("blocked_users").delete().eq("user_id", accountId)
      : await supabase.from("blocked_users").insert({ user_id: accountId, reason: "ადმინისტრატორის მიერ შეზღუდული ანგარიში" });
    if (result.error) return showNotice("ანგარიშის შეზღუდვა ვერ მოხერხდა.");
    await loadAdminData();
    showNotice(alreadyBlocked.data ? "ანგარიშის შეზღუდვა მოიხსნა." : "ანგარიში შეიზღუდა.");
  };

  const visiblePosts = posts.filter((post) => {
    const topicMatch = activeTopic === "ყველა" || activeTopic === "პოპულარული" || post.topic === activeTopic;
    const searchMatch = !search || `${post.body} ${post.topic} ${post.comments.map((comment) => comment.body).join(" ")}`
      .toLocaleLowerCase("ka-GE").includes(search.toLocaleLowerCase("ka-GE"));
    return topicMatch && searchMatch;
  }).sort((left, right) => activeTopic === "პოპულარული"
    ? right.comments.length - left.comments.length
    : new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" onClick={() => { setAdminOpen(false); setActiveTopic("ყველა"); }}>
          <span className="brand-mark"><MessageCircle size={23} strokeWidth={2.6} /><span /></span>
          <span className="brand-word">ჭორაობა<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-center"><span className="live-dot" /> ქალაქის საერთო ოთახი</div>
        <div className="topbar-actions">
          <button className="icon-button top-search" title="ძებნა" onClick={() => document.getElementById("feed-search")?.focus()}><CircleHelp size={18} /></button>
          {user ? (
            <div className="account-chip"><span className="account-avatar"><UserRound size={17} /></span><span className="account-label">ანონიმური ანგარიში</span><button className="chip-action" title="გასვლა" onClick={signOut}><LogOut size={15} /></button></div>
          ) : <button className="login-button" onClick={() => { setAuthMode("login"); setAuthOpen(true); }}><LogIn size={16} /> შესვლა</button>}
        </div>
      </header>

      <div className="page-grid">
        <aside className="left-rail">
          <div className="rail-label">შენი სივრცე</div>
          <nav className="primary-nav" aria-label="მთავარი მენიუ">
            <button className={!adminOpen && activeTopic === "ყველა" ? "nav-item active" : "nav-item"} onClick={() => { setAdminOpen(false); setActiveTopic("ყველა"); }}><Sparkles size={18} /> საერთო ლენტა <span className="nav-count">{posts.length}</span></button>
            <button className={!adminOpen && activeTopic === "პოპულარული" ? "nav-item active" : "nav-item"} onClick={() => { setAdminOpen(false); setActiveTopic("პოპულარული"); }}><ArrowDownRight size={18} /> პოპულარული</button>
            <button className="nav-item" onClick={() => user ? document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus() : (setAuthMode("signup"), setAuthOpen(true))}><Plus size={18} /> ახალი პოსტი</button>
          </nav>
          <div className="rail-divider" />
          <div className="rail-label">თემები <ChevronDown size={13} /></div>
          <nav className="topic-nav" aria-label="თემები">
            {topics.map((topic, index) => <button key={topic} className={activeTopic === topic && !adminOpen ? "topic-link selected" : "topic-link"} onClick={() => { setAdminOpen(false); setActiveTopic(topic); }}><span className={`topic-swatch swatch-${index}`} />{topic}</button>)}
          </nav>
          <div className="rail-bottom-note"><div className="note-icon"><LockKeyhole size={15} /></div><p>შენი სახელი არ ჩანს.<br /><strong>აქ ყველა ანონიმია.</strong></p><span className="note-scribble">✓</span></div>
        </aside>

        <main className="main-column">
          {adminOpen ? (
            <section className="admin-page">
              <button className="back-link" onClick={() => setAdminOpen(false)}><ArrowLeft size={16} /> ლენტაზე დაბრუნება</button>
              <div className="admin-heading"><span className="admin-icon"><ShieldCheck size={23} /></span><div><p className="eyebrow">მხოლოდ ადმინისტრატორისთვის</p><h1>მოდერაციის ოთახი</h1></div><span className="report-count">{reports.length} ღია</span></div>
              <p className="admin-description">საჩივრებზე წვდომა და ანგარიშის იდენტიფიკატორები მხოლოდ შენ გეჩვენება. მომხმარებლები ერთმანეთს კვლავ ანონიმურად ხედავენ.</p>
              {reports.length === 0 ? <div className="empty-reports"><ShieldCheck size={28} /><h2>ღია საჩივრები არ არის</h2><p>ახალი საჩივრები აქ გამოჩნდება.</p></div> : reports.map((report) => <article className="report-card" key={report.id}>
                <div className="report-card-top"><span className="report-kind"><Flag size={14} />{report.target_type === "post" ? "პოსტი" : "კომენტარი"}</span><span className="report-time">{formatTime(report.created_at)}</span></div>
                <p className="report-reason">მიზეზი: <strong>{report.reason}</strong></p><blockquote>{report.target_body}</blockquote>
                <div className="author-id"><span>ანგარიშის ID</span><code>{report.author_id ?? "მიუწვდომელია"}</code>{report.author_id && <button className="text-action" onClick={() => void toggleBan(report.author_id!)}>შეზღუდვის შეცვლა</button>}</div>
                <div className="report-actions"><button className="danger-action" onClick={() => void resolveReport(report, true)}><Trash2 size={15} /> წაშლა და დახურვა</button><button className="quiet-action" onClick={() => void resolveReport(report, false)}><Check size={15} /> უარყოფა</button></div>
              </article>)}
            </section>
          ) : <>
            <section className="welcome-band">
              <div className="welcome-copy"><span className="eyebrow"><span className="sparkle-star">✳</span> გულწრფელად, თავისუფლად</span><h1>თქვი რაც გაქვს<br /><em>სათქმელი.</em></h1><p>აზრები, რომლებსაც სხვაგან ვერ ამბობ.</p></div>
              <div className="welcome-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-shape"><MessageCircle size={45} strokeWidth={1.4} /><span>?</span></div><span className="art-sparkle">✳</span><span className="art-caption">სრულიად ანონიმურად</span></div>
              <div className="welcome-stamp"><span>თქვი</span><span>შენი</span><strong>სიმართლე</strong></div>
            </section>

            {!backendReady && <div className="setup-notice"><div className="setup-icon"><LockKeyhole size={17} /></div><div><strong>საერთო ლენტა ჯერ არ არის დაკავშირებული</strong><span>დააკონფიგურირე Supabase-ის მისამართი და გასაღები, რომ მონაცემები რეალურად შეინახოს.</span></div><button title="ინსტრუქცია README-ში" onClick={() => showNotice("ინსტრუქცია მოცემულია README.md ფაილში.")}><CircleHelp size={18} /></button></div>}
            {suspended && <div className="suspension-notice"><ShieldAlert size={18} /> ანგარიში დროებით შეზღუდულია. პოსტებისა და კომენტარების დამატება შეუძლებელია.</div>}

            <section className="composer" aria-label="პოსტის შექმნა">
              <div className="composer-top"><span className="composer-avatar"><UserRound size={20} /></span><form className="composer-form" onSubmit={submitPost}>
                <textarea value={postText} onChange={(event) => setPostText(event.target.value)} maxLength={1200} placeholder={user ? "რა ხდება შენს გონებაში?" : "შესვლა დაგჭირდება, რომ შენი აზრი გააზიარო..."} onFocus={() => { if (!user && backendReady) setAuthOpen(true); }} />
                {previewUrl && <div className="image-preview"><img src={previewUrl} alt="ასატვირთი ფოტო" /><button type="button" title="ფოტოს მოცილება" onClick={() => setFile(null)}><X size={16} /></button></div>}
                <div className="composer-bottom"><div className="composer-tools"><button type="button" className="tool-button" title="ფოტოს დამატება" onClick={() => fileInput.current?.click()}><ImagePlus size={18} /><span>ფოტო</span></button><input ref={fileInput} hidden type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><label className="topic-select-label"><span className="mini-swatch" /> <select value={selectedTopic} onChange={(event) => setSelectedTopic(event.target.value as Topic)} aria-label="პოსტის თემა">{topics.map((topic) => <option key={topic}>{topic}</option>)}</select><ChevronDown size={13} /></label></div><div className="composer-submit"><span className="character-count">{postText.length}/1200</span><button className="publish-button" type="submit" disabled={posting || suspended}>{posting ? "იგზავნება..." : <>გამოქვეყნება <Send size={14} /></>}</button></div></div>
              </form></div>
            </section>

            <div className="feed-toolbar"><div className="feed-heading"><span className="feed-marker" /><h2>{activeTopic === "ყველა" ? "საერთო ლენტა" : activeTopic}</h2><span className="feed-total">{visiblePosts.length}</span></div><div className="feed-controls"><label className="search-box"><input id="feed-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ძებნა..." /><span>⌘ K</span></label><button className="sort-button" onClick={() => setActiveTopic(activeTopic === "პოპულარული" ? "ყველა" : "პოპულარული")}><Clock3 size={15} /> ახალი <ChevronDown size={13} /></button></div></div>

            {loading ? <div className="loading-state"><span className="loading-dot" /><span>ლენტა იტვირთება...</span></div> : visiblePosts.length === 0 ? <div className="empty-feed"><div className="empty-illustration"><MessageCircle size={33} /><span>✳</span></div><h3>{backendReady ? "აქ ჯერ სიჩუმეა." : "შენი პირველი პოსტი აქ გამოჩნდება."}</h3><p>{backendReady ? "დაიწყე საუბარი: გააზიარე აზრი, შეკითხვა ან ფოტო." : "დაუკავშირე Supabase და ლენტა საერთო გახდება."}</p><button onClick={() => user ? document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus() : setAuthOpen(true)}><Plus size={16} /> საუბრის დაწყება</button></div> : visiblePosts.map((post, index) => <PostCard
              key={post.id}
              post={post}
              index={index}
              user={user}
              admin={admin}
              expanded={openComments === post.id}
              replyTo={replyTo?.post_id === post.id ? replyTo : null}
              onToggleComments={() => { setOpenComments(openComments === post.id ? null : post.id); setReplyTo(null); }}
              onReply={setReplyTo}
              onComment={(body) => void submitComment(post.id, body)}
              onReport={(type, id) => setReportTarget({ type, id })}
              onDelete={() => void deletePost(post)}
              onDeleteComment={(id) => void deleteComment(id)}
              onAuth={() => setAuthOpen(true)}
            />)}
            {reportTarget && <div className="modal-backdrop" onClick={() => setReportTarget(null)}><form className="report-modal" onSubmit={submitReport} onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setReportTarget(null)}><X size={18} /></button><span className="modal-icon"><Flag size={19} /></span><h2>საჩივრის გაგზავნა</h2><p>მოდერატორი შეამოწმებს ამ შინაარსს.</p><label>მიზეზი<select name="reason">{reasons.map((reason) => <option key={reason}>{reason}</option>)}</select></label><button className="publish-button modal-submit" type="submit">გაგზავნა <Send size={14} /></button></form></div>}
          </>}
        </main>

        <aside className="right-rail">
          <div className="right-heading"><h2>დღის საუბარი</h2><span>✳</span></div>
          <button className="daily-question" onClick={() => { setPostText("შეკითხვა: რისი თქმა გინდოდა დღეს, მაგრამ ვერ თქვი?"); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); }}><span className="question-kicker">დღის შეკითხვა <ArrowDownRight size={15} /></span><strong>რისი თქმა გინდოდა დღეს, მაგრამ ვერ თქვი?</strong><span className="question-link">უპასუხე ანონიმურად <span>↗</span></span></button>
          <div className="trending-head"><h2>საუბრის თემები</h2><span>ახლა</span></div>
          <div className="trending-list">{[
            ["#", "ურთიერთობები", "ორი აზრი ერთდროულად"],
            ["//", "სამსახური", "ორშაბათის აღსარება"],
            ["✳", "ცხოვრება", "პატარა გამარჯვებები"],
          ].map(([icon, topic, title], index) => <button className="trending-item" key={topic} onClick={() => setActiveTopic(topic as Topic)}><span className={`trend-icon trend-${index}`}>{icon}</span><span className="trend-copy"><strong>{title}</strong><small>{topic}</small></span><ArrowDownRight size={15} /></button>)}</div>
          <div className="community-stats"><div className="stats-icon"><UsersRound size={17} /></div><div><strong>{backendReady ? "საერთო სივრცე" : "ახალი სივრცე"}</strong><span>{backendReady ? "ყველა ანონიმურად საუბრობს" : "შენთან ერთად იწყება"}</span></div><span className="stats-live"><span />LIVE</span></div>
          <div className="rules-block"><div className="rules-title"><ShieldCheck size={16} /><strong>ჩვენი წესები</strong></div><p>გულწრფელობა კი. ზიანი არა.</p><span>პატივისცემა, პირადი საზღვრები და კეთილი სიტყვა.</span></div>
          {admin && <button className="admin-entry" onClick={() => { setAdminOpen(true); void loadAdminData(); }}><ShieldCheck size={16} /> მოდერაციის ოთახი <span>{reports.length || ""}</span></button>}
          <footer className="site-footer"><span>ჭორაობა © 2025</span><button onClick={() => showNotice("მონაცემების წაშლის хүсանքով холվեք կայքի ადმინისტრატორს։")}><CircleHelp size={13} /> უსაფრთხოება</button></footer>
        </aside>
      </div>

      <nav className="mobile-nav"><button className="mobile-active" onClick={() => { setAdminOpen(false); setActiveTopic("ყველა"); }}><Sparkles size={19} /><span>ლენტა</span></button><button onClick={() => document.getElementById("feed-search")?.focus()}><CircleHelp size={19} /><span>ძებნა</span></button><button className="mobile-create" onClick={() => { if (!user) setAuthOpen(true); else document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); }}><Plus size={22} /></button><button onClick={() => { setActiveTopic("პოპულარული"); setAdminOpen(false); }}><ArrowDownRight size={19} /><span>პოპულარული</span></button><button onClick={() => user ? void signOut() : setAuthOpen(true)}><UserRound size={19} /><span>{user ? "გასვლა" : "ანგარიში"}</span></button></nav>

      {authOpen && <div className="modal-backdrop" onClick={() => setAuthOpen(false)}><form className="auth-modal" onSubmit={submitAuth} onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setAuthOpen(false)}><X size={18} /></button><span className="auth-mark"><MessageCircle size={26} /></span><p className="eyebrow">ანონიმური სივრცე</p><h2>{authMode === "signup" ? "შემოგვიერთდი." : "კეთილი იყოს შენი დაბრუნება."}</h2><p className="auth-hint">შენი ელფოსტა და სახელი საჯაროდ არ გამოჩნდება.</p><label>ელფოსტა<input name="email" type="email" autoComplete="email" placeholder="შენ@example.com" required /></label><label>პაროლი<input name="password" type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={8} placeholder="მინიმუმ 8 სიმბოლო" required /></label><button className="publish-button auth-submit" type="submit" disabled={authBusy || !backendReady}>{authBusy ? "მუშავდება..." : authMode === "signup" ? "ანგარიშის შექმნა" : "შესვლა"}<ArrowDownRight size={17} /></button>{!backendReady && <p className="auth-config-note">ანგარიშის შექმნამდე დააკონფიგურირე Supabase.</p>}<button type="button" className="auth-switch" onClick={() => setAuthMode(authMode === "signup" ? "login" : "signup")}>{authMode === "signup" ? "უკვე გაქვს ანგარიში? შესვლა" : "ახალი ხარ? ანგარიშის შექმნა"}</button><div className="privacy-line"><LockKeyhole size={13} /> საჯარო პოსტებსა და კომენტარებში ყველანი „ანონიმი“ არიან.</div></form></div>}
      {notice && <div className="toast" role="status"><span className="toast-mark"><Check size={15} /></span>{notice}<button onClick={() => setNotice("")}><X size={15} /></button></div>}
    </div>
  );
}

type PostCardProps = {
  post: Post;
  index: number;
  user: User | null;
  admin: boolean;
  expanded: boolean;
  replyTo: Comment | null;
  onToggleComments: () => void;
  onReply: (comment: Comment | null) => void;
  onComment: (body: string) => void;
  onReport: (type: "post" | "comment", id: string) => void;
  onDelete: () => void;
  onDeleteComment: (id: string) => void;
  onAuth: () => void;
};

function PostCard({ post, index, user, admin, expanded, replyTo, onToggleComments, onReply, onComment, onReport, onDelete, onDeleteComment, onAuth }: PostCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const topLevel = post.comments.filter((comment) => !comment.parent_id);
  const repliesFor = (id: string) => post.comments.filter((comment) => comment.parent_id === id);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!commentText.trim()) return;
    onComment(commentText);
    setCommentText("");
  };

  return <article className="post-card" style={{ animationDelay: `${Math.min(index, 6) * 55}ms` }}>
    <div className="post-meta"><span className="post-avatar"><UserRound size={17} /></span><div className="post-author"><strong>ანონიმი</strong><span>{formatTime(post.created_at)} <i /> <span className="post-topic">{post.topic}</span></span></div><button className="post-menu-button" title="მეტი" onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={20} /></button>{menuOpen && <div className="post-menu"><button onClick={() => { onReport("post", post.id); setMenuOpen(false); }}><Flag size={14} /> საჩივარი</button>{(post.is_mine || admin) && <button className="menu-danger" onClick={onDelete}><Trash2 size={14} /> წაშლა</button>}</div>}</div>
    {post.body && <p className="post-body">{post.body}</p>}
    {post.image_url && <div className="post-image-wrap"><img src={post.image_url} alt="ანონიმური პოსტის ფოტო" loading="lazy" /></div>}
    <div className="post-bottom"><span className="post-topic-mobile">#{post.topic}</span><button className={expanded ? "comment-toggle is-open" : "comment-toggle"} onClick={onToggleComments}><MessageCircle size={17} /><strong>{post.comments.length}</strong><span>{post.comments.length === 1 ? "კომენტარი" : "კომენტარი"}</span><span className="comment-toggle-arrow">↗</span></button><button className="post-share" title="გაზიარება" onClick={() => void navigator.clipboard?.writeText(window.location.href)}><ArrowDownRight size={17} /></button></div>
    {expanded && <div className="comments-panel"><div className="comments-heading"><span>საუბარი</span><span>{post.comments.length} კომენტარი</span></div>{post.comments.length === 0 ? <p className="no-comments">პირველი კომენტარი შენ დაწერე.</p> : topLevel.map((comment) => <div className="comment-thread" key={comment.id}><CommentRow comment={comment} user={user} admin={admin} onReply={() => onReply(comment)} onReport={() => onReport("comment", comment.id)} onDelete={() => onDeleteComment(comment.id)} onAuth={onAuth} /><div className="comment-replies">{repliesFor(comment.id).map((reply) => <CommentRow key={reply.id} comment={reply} user={user} admin={admin} onReply={() => onReply(reply)} onReport={() => onReport("comment", reply.id)} onDelete={() => onDeleteComment(reply.id)} onAuth={onAuth} />)}</div></div>)}{replyTo && <div className="replying-to"><span><ArrowDownRight size={13} /> პასუხი ანონიმს</span><button onClick={() => onReply(null)}><X size={14} /></button></div>}<form className="comment-form" onSubmit={submit}><span className="comment-avatar"><UserRound size={15} /></span><input value={commentText} onFocus={() => { if (!user) onAuth(); }} onChange={(event) => setCommentText(event.target.value)} maxLength={600} placeholder={user ? "კომენტარის დამატება..." : "შესასვლელად დააკლიკე..."} /><button title="კომენტარის გაგზავნა" type="submit" disabled={!commentText.trim()}><Send size={16} /></button></form></div>}
  </article>;
}

function CommentRow({ comment, user, admin, onReply, onReport, onDelete, onAuth }: { comment: Comment; user: User | null; admin: boolean; onReply: () => void; onReport: () => void; onDelete: () => void; onAuth: () => void }) {
  return <div className="comment-row"><span className="comment-avatar"><UserRound size={14} /></span><div className="comment-content"><div className="comment-bubble"><strong>ანონიმი</strong><p>{comment.body}</p></div><div className="comment-actions"><span>{formatTime(comment.created_at)}</span><button onClick={user ? onReply : onAuth}>პასუხი</button>{(comment.is_mine || admin) ? <button onClick={onDelete}>წაშლა</button> : <button onClick={onReport}>გასაჩივრება</button>}</div></div></div>;
}

export default App;