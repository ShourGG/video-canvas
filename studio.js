/* Separate workspace view: the original portrait editor keeps its own state. */
(() => {
  let shots = [], jobs = [], selected = null, chars = [], frameChoice = "";
  let busy = false, saveChain = Promise.resolve(), pollBusy = false, initialized = false;
  const fields = {title:"shotTitle", chapter:"shotChapter", scene:"shotScene", frame_prompt:"shotFrame", video_prompt:"shotMotion", dialogue:"shotDialogue", notes:"shotNotes"};
  const labels = {queued:"等待本机队列", running:"处理中", waiting:"等待续查", paused:"已暂停 · 可续查", needs_review:"提交待核对", completed:"已完成", failed:"失败"};
  const media = (job, file) => `/video-media/${job.id}/${file}`;
  const message = (text, error=false) => {
    if ($("shotStatus")) { $("shotStatus").textContent = text; $("shotStatus").className = error ? "error" : ""; }
  };
  const shotJobs = () => jobs.filter(j => j.shot_id === selected?.id);
  const pendingJob = () => shotJobs().find(j => ["queued","running","waiting","paused","needs_review"].includes(j.status));

  function setTab(video) {
    for (const id of ["characterSidebar", "main"]) $(id).hidden = video;
    for (const id of ["videoSidebar", "videoMain"]) $(id).hidden = !video;
    $("tabCharacters").classList.toggle("active", !video);
    $("tabVideos").classList.toggle("active", video);
    if (video && !initialized) init().catch(e => message(e.message, true));
    else if (video) api("/api/state").then(s=>{
      chars=s.characters;
      for(const input of document.querySelectorAll("#shotCharacters input")) {
        const c=chars.find(x=>x.name===input.value), img=input.parentElement.querySelector("img");
        if(c?.portrait && img)img.src=imgUrl(c.name,c.portrait);
      }
    }).catch(e=>message(e.message,true));
  }

  function renderList() {
    const q = $("shotSearch").value.trim();
    $("shotList").innerHTML = shots.filter(s => !q || [s.number,s.title,s.chapter,...(s.characters||[])].join(" ").includes(q)).map(s => {
      const j = jobs.find(x => x.shot_id === s.id);
      return `<div class="shot-item ${selected?.id === s.id ? "active" : ""}" data-shot="${esc(s.id)}"><div>${String(s.number).padStart(2,"0")} · ${esc(s.title)}</div><div class="muted">${esc(s.duration)} 秒 · ${esc(j ? labels[j.status] : "待制作")}</div></div>`;
    }).join("");
    const active = jobs.filter(j => ["queued","running","waiting"].includes(j.status)).length;
    $("studioSummary").textContent = `${shots.length} 个分镜 · ${jobs.filter(j=>j.video_file).length} 段视频${active ? ` · ${active} 个任务处理中` : ""}`;
  }

  function readDraft() {
    if (!selected || !$("shotTitle")) return null;
    const s = {...selected};
    for (const [key, id] of Object.entries(fields)) s[key] = $(id).value;
    s.duration = Number($("shotDuration").value);
    s.size = $("shotSize").value;
    s.characters = Array.from(document.querySelectorAll("#shotCharacters input:checked"), el => el.value);
    return s;
  }

  async function saveDraft(silent=false) {
    const draft = readDraft();
    if (!draft) return;
    // Serialize writes, so an earlier autosave cannot overwrite a newer draft.
    const operation = saveChain.catch(()=>{}).then(() => api("/api/shots", {shot:draft}));
    saveChain = operation;
    const {shot} = await operation;
    const i = shots.findIndex(s=>s.id===shot.id);
    if (i < 0) shots.push(shot); else shots[i] = shot;
    if (selected?.id === shot.id) selected = shot;
    renderList();
    if (!silent) message("分镜已保存");
    return shot;
  }

  async function selectShot(id, save=true) {
    if (selected && save) await saveDraft(true);
    selected = shots.find(s=>s.id===id) || shots[0];
    if (!selected) { $("videoMain").innerHTML='<div class="empty">点左侧「新增分镜」开始</div>'; return; }
    frameChoice = "";
    const s = selected;
    const names = new Set(s.characters || []);
    const known = [...names, ...chars.filter(c => c.kind !== "scene").slice(0, 4).map(c => c.name)];
    const choices = chars.filter(c => known.includes(c.name));
    $("videoMain").innerHTML = `
      <div class="row" style="margin-top:0;justify-content:space-between"><h2 style="margin:0">分镜 ${esc(s.number)} · ${esc(s.title)}</h2><button class="secondary" id="saveShot">保存分镜</button></div>
      <div class="muted">定妆照作为人物参考，先生成场景首帧，再生成有同期声的视频。新任务在后台排队，刷新后可继续查看。</div>
      <div class="studio-grid"><section>
        <div class="studio-box">
          <label>分镜标题</label><input type="text" id="shotTitle" value="${esc(s.title)}">
          <label>章节</label><input type="text" id="shotChapter" value="${esc(s.chapter)}">
          <div class="row"><label style="margin:0">时长（秒）</label><input type="number" id="shotDuration" min="1" max="30" style="width:76px" value="${esc(s.duration)}"><select id="shotSize">${["16:9","9:16","1:1","4:3","3:4"].map(v=>`<option ${s.size===v?"selected":""}>${v}</option>`).join("")}</select></div>
          <div class="muted">长对白要留足时间；模型支持的时长以接口为准，超长对白可拆成多个分镜。</div>
          <label>出场角色（使用各自当前选定的定妆照）</label>
          <div id="shotCharacters">${choices.map(c=>`<label class="character-choice"><input type="checkbox" value="${esc(c.name)}" ${names.has(c.name)?"checked":""}>${c.portrait?`<img src="${imgUrl(c.name,c.portrait)}" alt="${esc(c.name)}">`:""}${esc(c.name)}${c.portrait?"":"（未定妆）"}</label>`).join("")}</div>
          <div class="row"><select id="otherCharacter" style="flex:1"><option value="">添加其他角色…</option>${chars.filter(c=>!choices.includes(c)).map(c=>`<option>${esc(c.name)}</option>`).join("")}</select><button class="secondary" id="addCharacter">添加</button></div>
          <label>场景</label><textarea id="shotScene" rows="3">${esc(s.scene)}</textarea>
          <label>首帧画面</label><textarea id="shotFrame" rows="4">${esc(s.frame_prompt)}</textarea>
          <label>视频动作、机位与表演</label><textarea id="shotMotion" rows="5">${esc(s.video_prompt)}</textarea>
          <label>对白（按人物标注；若动作提示词已有对白，可留空）</label><textarea id="shotDialogue" rows="3" placeholder="林舟：天快黑了，我们在这里歇一晚吧。">${esc(s.dialogue)}</textarea>
          <label>制作备注</label><textarea id="shotNotes" rows="2">${esc(s.notes)}</textarea>
          <div class="row"><button class="secondary" id="previewPrompts">查看最终提示词</button></div>
          <details id="promptDetails" hidden><summary>发送给接口的提示词</summary><div id="finalPrompts" class="prompt-text"></div></details>
        </div>
      </section><section>
        <div class="studio-box"><h3>1 · 场景首帧</h3><select id="frameSelect" style="width:100%;margin-bottom:10px"></select><img id="framePreview" hidden alt="分镜首帧"><div id="noFrame" class="muted">还没有首帧。选好角色后点「生成首帧」。</div><div class="row"><button class="secondary" id="makeFrame">生成首帧</button><button id="makeBoth">首帧 → 视频</button></div><div class="muted">「首帧 → 视频」会复用选定首帧；没有首帧时才先生成。</div></div>
        <div class="studio-box"><h3>2 · 分镜视频</h3><video id="videoPreview" controls playsinline preload="metadata" hidden></video><div id="noVideo" class="muted">完成后可在这里播放原视频与音轨。</div><div class="row"><button id="makeVideo">用选定首帧生成视频</button><a id="downloadVideo" hidden download>下载 MP4</a></div><div class="muted" id="videoNote"></div></div>
        <div id="shotStatus" role="status"></div>
        <div class="studio-box"><h3>任务记录</h3><div id="jobList"></div></div>
      </section></div>`;
    $("saveShot").onclick = () => saveDraft().catch(e=>message(e.message,true));
    for (const el of document.querySelectorAll("#videoMain input, #videoMain textarea, #shotSize")) {
      el.addEventListener("change", () => saveDraft(true).catch(e=>message(e.message,true)));
    }
    $("addCharacter").onclick = () => {
      const name=$("otherCharacter").value;
      if (!name) return;
      const label=document.createElement("label");label.className="character-choice";
      const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.value=name;checkbox.checked=true;
      label.append(checkbox, document.createTextNode(name));$("shotCharacters").append(label);
      $("otherCharacter").selectedOptions[0].remove();
      saveDraft(true).catch(e=>message(e.message,true));
    };
    $("previewPrompts").onclick = async () => {
      try { const p=await api("/api/shots/preview",{shot:readDraft()});$("finalPrompts").textContent=`首帧：\n${p.frame}\n\n视频：\n${p.video}`;$("promptDetails").hidden=false;$("promptDetails").open=true; }
      catch(e) {message(e.message,true);}
    };
    $("makeFrame").onclick=()=>submit("frame");$("makeBoth").onclick=()=>submit("both");$("makeVideo").onclick=()=>submit("video");
    $("frameSelect").onchange=()=>{frameChoice=$("frameSelect").value;renderOutputs();};
    renderList();renderOutputs();
  }

  function renderOutputs() {
    if (!selected || !$("jobList")) return;
    const list=shotJobs(), frames=list.filter(j=>j.frame_file), videos=list.filter(j=>j.video_file);
    if (!frames.some(j=>j.id===frameChoice)) frameChoice=frames[0]?.id||"";
    $("frameSelect").innerHTML=frames.map(j=>`<option value="${j.id}" ${j.id===frameChoice?"selected":""}>${esc(j.created_at)}${j.imported?" · 恢复样片":""}</option>`).join("");
    $("frameSelect").hidden=!frames.length;
    const f=frames.find(j=>j.id===frameChoice);
    $("framePreview").hidden=!f;$("noFrame").hidden=!!f;
    if(f && $("framePreview").getAttribute("src")!==media(f,f.frame_file)) $("framePreview").src=media(f,f.frame_file);
    const v=videos[0];$("videoPreview").hidden=!v;$("noVideo").hidden=!!v;$("downloadVideo").hidden=!v;
    if(v) {
      const url=media(v,v.video_file);
      if($("videoPreview").getAttribute("src")!==url) $("videoPreview").src=url;
      $("downloadVideo").href=url;$("downloadVideo").download=`${selected.id}.mp4`;
      $("videoNote").textContent=v.notes||"保留接口原音轨。生成完成后，请试听对白并检查口型。";
    } else $("videoNote").textContent="";
    const blocked=!!pendingJob();
    $("makeFrame").disabled=busy||blocked;$("makeBoth").disabled=busy||blocked;$("makeVideo").disabled=busy||blocked||!f;
    // Media elements above stay mounted while status polling updates the task log.
    const signature=JSON.stringify(list);
    if($("jobList").dataset.signature===signature) return;
    $("jobList").dataset.signature=signature;
    $("jobList").innerHTML=list.length?list.map(j=>`<div class="job-row"><strong>${esc(labels[j.status]||j.status)}</strong> · ${j.stage==="frame"?"首帧":"视频"}${typeof j.progress==="number"?` ${j.progress}%`:""}<div class="muted">${esc(j.created_at)}${j.imported?" · 已恢复样片":""}</div>${Object.entries(j.stages).filter(([,s])=>s.task_id).map(([n,s])=>`<div>${n==="frame"?"图片":"视频"} ID：<code>${esc(s.task_id)}</code></div>`).join("")}${j.error?`<div class="job-error">${esc(j.error)}</div>`:""}<div class="row">${["queued","running","waiting"].includes(j.status)?`<button class="secondary" data-pause="${j.id}">暂停本机查询</button>`:""}${["paused","needs_review"].includes(j.status)?`${j.status==="needs_review"?`<input data-task-for="${j.id}" placeholder="工作台中的原任务 ID" style="width:220px">`:""}<button class="secondary" data-resume="${j.id}">续查原任务</button>`:""}${j.video_file?`<a href="${media(j,j.video_file)}" target="_blank" rel="noopener">打开此版视频</a>`:""}</div></div>`).join(""):'<div class="muted">暂无任务。每次提交会先保存记录，后续状态自动更新。</div>';
    $("jobList").onclick=async e=>{
      const button=e.target.closest("button");if(!button)return;
      const id=button.dataset.pause||button.dataset.resume;
      button.disabled=true;
      try {await api(`/api/video/jobs/${id}/${button.dataset.pause?"pause":"resume"}`, {task_id:document.querySelector(`[data-task-for="${id}"]`)?.value||""});await refresh();}
      catch(err){message(err.message,true);button.disabled=false;}
    };
  }

  async function submit(action) {
    if(busy)return;
    busy=true;renderOutputs();
    try {
      await saveDraft(true);
      const old=sessionStorage.getItem("studioPendingSubmit");
      let payload=old?JSON.parse(old):null;
      if(payload && (payload.shot_id!==selected.id || payload.action!==action)) throw new Error("还有一次未确认的提交，请先查看该分镜的任务记录，或重试原操作以核对。");
      payload ||= {shot_id:selected.id, action, frame_job_id:frameChoice||undefined, request_id:crypto.randomUUID()};
      // Retain the same request ID after a browser/network error; do not mint a retry ID.
      sessionStorage.setItem("studioPendingSubmit",JSON.stringify(payload));
      const {job}=await api("/api/video/jobs",payload);
      sessionStorage.removeItem("studioPendingSubmit");
      jobs=[job,...jobs.filter(j=>j.id!==job.id)];
      message("任务已保存并排队，可以刷新或切换分镜查看。");
    } catch(e) {
      if(e.status>=400 && e.status<500)sessionStorage.removeItem("studioPendingSubmit");
      message("提交未确认："+e.message+"。任务记录会自动核对，请先查看记录。",true);
    }
    finally {busy=false;await refresh();}
  }

  async function refresh() {
    if(pollBusy)return;pollBusy=true;
    try {
      const result=await api("/api/video/jobs");jobs=result.jobs;
      const pending=sessionStorage.getItem("studioPendingSubmit");
      if(pending && jobs.some(j=>j.request_id===JSON.parse(pending).request_id)) sessionStorage.removeItem("studioPendingSubmit");
      renderList();renderOutputs();
    } catch(e) {message("读取任务失败："+e.message,true);}
    finally{pollBusy=false;}
  }

  async function init() {
    initialized=true;
    const [data,characters]=await Promise.all([api("/api/shots"),api("/api/state")]);shots=data.shots;chars=characters.characters;
    await refresh();
    const id=location.hash.split("/")[1] || shots[0]?.id;
    await selectShot(id,false);
    setInterval(refresh,3000);
  }
  $("tabCharacters").onclick=()=>{setTab(false);location.hash="characters";};
  $("tabVideos").onclick=()=>{setTab(true);location.hash="videos";};
  $("videoSettings").onclick=openSettings;
  $("shotSearch").oninput=renderList;
  $("shotList").onclick=e=>{const el=e.target.closest("[data-shot]");if(el) selectShot(el.dataset.shot).then(()=>{location.hash="videos/"+selected.id;}).catch(err=>message(err.message,true));};
  $("addShot").onclick=async()=>{
    try {
      if(selected)await saveDraft(true);
      const shot={title:"新分镜",chapter:selected?.chapter||"新章节",duration:5,size:"16:9",characters:[],scene:"",frame_prompt:"",video_prompt:"",dialogue:"",notes:""};
      const result=await api("/api/shots",{shot});shots.push(result.shot);await selectShot(result.shot.id,false);
    }catch(e){message(e.message,true);}
  };
  window.addEventListener("hashchange",()=>setTab(location.hash.startsWith("#videos")));
  setTab(location.hash.startsWith("#videos"));
})();
