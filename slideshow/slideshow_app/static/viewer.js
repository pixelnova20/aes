const presentation = JSON.parse(document.getElementById('presentation-data').textContent);
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
const thumbnailList = document.getElementById('thumbnail-list');
const currentSlide = document.getElementById('current-slide');
const imageError = document.getElementById('slide-image-error');
const previousButton = document.getElementById('previous-slide');
const nextButton = document.getElementById('next-slide');
const fullscreenButton = document.getElementById('fullscreen-button');
const fullscreenTarget = document.getElementById('fullscreen-target');
const viewerLayout = document.getElementById('viewer-layout');
const pageIndicator = document.getElementById('header-page-indicator');
const chatSlideLabel = document.getElementById('chat-slide-label');
const chatMessages = document.getElementById('chat-messages');
const chatEmpty = document.getElementById('chat-empty');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatState = document.getElementById('chat-state');
const chatOpenButton = document.getElementById('chat-open-button');
const chatCloseButton = document.getElementById('chat-close-button');

let currentIndex = 0;
let chatLoading = false;
const messages = [];

function setChatOpen(open) {
  if (!viewerLayout?.classList.contains('student-chat-collapsible')) return;
  viewerLayout.classList.toggle('chat-open', open);
  chatOpenButton?.setAttribute('aria-expanded', String(open));
  if (open) chatInput.focus();
  else chatOpenButton?.focus();
}

chatOpenButton?.addEventListener('click', () => setChatOpen(true));
chatCloseButton?.addEventListener('click', () => setChatOpen(false));

function createThumbnails() {
  presentation.slides.forEach((slide) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumbnail-button';
    button.dataset.index = String(slide.index);
    button.setAttribute('aria-label', `查看第 ${slide.index + 1} 页`);
    const number = document.createElement('span');
    number.textContent = String(slide.index + 1);
    const image = document.createElement('img');
    image.src = slide.imageUrl;
    image.alt = `第 ${slide.index + 1} 页缩略图`;
    image.loading = slide.index < 4 ? 'eager' : 'lazy';
    button.append(number, image);
    button.addEventListener('click', () => showSlide(slide.index));
    thumbnailList.appendChild(button);
  });
}

function showSlide(index) {
  if (index < 0 || index >= presentation.slides.length) return;
  currentIndex = index;
  const slide = presentation.slides[index];
  imageError.hidden = true;
  currentSlide.hidden = false;
  currentSlide.src = slide.imageUrl;
  currentSlide.alt = `${presentation.title}，第 ${index + 1} 页`;
  previousButton.disabled = index === 0;
  nextButton.disabled = index === presentation.slides.length - 1;
  pageIndicator.textContent = `${index + 1} / ${presentation.slideCount}`;
  chatSlideLabel.textContent = `基于当前第 ${index + 1} 页`;
  document.querySelectorAll('.thumbnail-button').forEach((button) => {
    const active = Number(button.dataset.index) === index;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
    if (active) button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

currentSlide.addEventListener('error', () => {
  currentSlide.hidden = true;
  imageError.hidden = false;
});
previousButton.addEventListener('click', () => showSlide(currentIndex - 1));
nextButton.addEventListener('click', () => showSlide(currentIndex + 1));

fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === fullscreenTarget) await document.exitFullscreen();
    else await fullscreenTarget.requestFullscreen();
  } catch {
    chatState.textContent = '浏览器未允许进入全屏。';
  }
});

document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === fullscreenTarget;
  fullscreenButton.querySelector('span').textContent = active ? '退出全屏' : '全屏';
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && viewerLayout?.classList.contains('chat-open') && !document.fullscreenElement) {
    event.preventDefault();
    setChatOpen(false);
    return;
  }
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
  const actions = {
    ArrowLeft: () => showSlide(currentIndex - 1),
    PageUp: () => showSlide(currentIndex - 1),
    ArrowRight: () => showSlide(currentIndex + 1),
    PageDown: () => showSlide(currentIndex + 1),
    Home: () => showSlide(0),
    End: () => showSlide(presentation.slides.length - 1),
  };
  if (actions[event.key]) {
    event.preventDefault();
    actions[event.key]();
  }
});

function appendMessage(role, content, pending = false) {
  chatEmpty.hidden = true;
  const row = document.createElement('div');
  row.className = `chat-message chat-message-${role}`;
  const label = document.createElement('span');
  label.textContent = role === 'user' ? '你' : 'AI';
  const bubble = document.createElement('div');
  bubble.className = pending ? 'chat-bubble pending' : 'chat-bubble';
  if (role === 'assistant' && !pending && window.marked && window.DOMPurify) {
    bubble.innerHTML = window.DOMPurify.sanitize(window.marked.parse(content, { breaks: true, gfm: true }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'style'],
      FORBID_ATTR: ['style'],
    });
  } else {
    bubble.textContent = content;
  }
  row.append(label, bubble);
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

function renderAssistantMarkdown(element, content) {
  element.classList.remove('pending');
  if (window.marked && window.DOMPurify) {
    element.innerHTML = window.DOMPurify.sanitize(window.marked.parse(content, { breaks: true, gfm: true }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'style'],
      FORBID_ATTR: ['style'],
    });
  } else {
    element.textContent = content;
  }
  element.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
}

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = chatInput.value.trim();
  if (!prompt || chatLoading) return;
  const slideIndex = currentIndex;
  const history = messages.slice(-12).map(({ role, content }) => ({ role, content }));
  appendMessage('user', prompt);
  messages.push({ role: 'user', content: prompt, slideIndex });
  const assistantBubble = appendMessage('assistant', '正在思考...', true);
  chatInput.value = '';
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatLoading = true;
  chatState.textContent = `正在理解第 ${slideIndex + 1} 页...`;
  let answer = '';
  let renderFrame = null;

  try {
    const result = await fetch(presentation.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ message: prompt, slideIndex, history }),
    });
    if (!result.ok) {
      const error = await result.json().catch(() => ({}));
      throw new Error(error.message || 'AI 请求失败。');
    }
    const reader = result.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const scheduleMarkdownRender = () => {
      if (renderFrame !== null) return;
      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        renderAssistantMarkdown(assistantBubble, answer);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const eventData = JSON.parse(line);
        if (eventData.error) throw new Error(eventData.error);
        if (eventData.delta) {
          answer += eventData.delta;
          scheduleMarkdownRender();
        }
      }
      if (done) break;
    }
    if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
    if (!answer.trim()) throw new Error('AI 没有返回有效内容。');
    renderAssistantMarkdown(assistantBubble, answer);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    messages.push({ role: 'assistant', content: answer, slideIndex });
    chatState.textContent = `回答基于第 ${slideIndex + 1} 页`;
  } catch (error) {
    if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
    assistantBubble.textContent = error instanceof Error ? error.message : 'AI 请求失败，请稍后重试。';
    assistantBubble.classList.remove('pending');
    assistantBubble.classList.add('chat-error');
    chatState.textContent = '发送失败';
  } finally {
    chatLoading = false;
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
});

createThumbnails();
showSlide(0);
