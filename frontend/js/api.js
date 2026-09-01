/* Обёртка над fetch: токен, язык, обработка ошибок. */

import { getLang } from "./i18n.js";

const TOKEN_KEY = "tiger.token";
const USER_KEY = "tiger.user";

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  },
  get user() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
  requireLogin() {
    if (!this.token) {
      window.location.replace("/");
      return false;
    }
    return true;
  },
};

/** URL файла с токеном: <img> и <video> не умеют слать Authorization. */
export function fileUrl(path) {
  if (!path) return "";
  if (!auth.token) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(auth.token)}`;
}

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function withLang(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}lang=${getLang()}`;
}

async function request(path, { method = "GET", json, form, signal } = {}) {
  const headers = { "X-Lang": getLang() };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }

  let response;
  try {
    response = await fetch(withLang(path), { method, headers, body, signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("network", "network", 0);
  }

  if (response.status === 401) {
    auth.clear();
    if (!window.location.pathname.endsWith("/")) window.location.replace("/");
    throw new ApiError("unauthorized", "unauthorized", 401);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || !data || data.ok === false) {
    const message = (data && data.message) || `HTTP ${response.status}`;
    const code = (data && data.error) || "http_error";
    throw new ApiError(message, code, response.status);
  }
  return data;
}

/* Загрузка файлов с прогрессом (fetch не отдаёт прогресс отправки). */
function upload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", withLang(path));
    if (auth.token) xhr.setRequestHeader("Authorization", `Bearer ${auth.token}`);
    xhr.setRequestHeader("X-Lang", getLang());

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status === 401) {
        auth.clear();
        window.location.replace("/");
        reject(new ApiError("unauthorized", "unauthorized", 401));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok !== false) {
        resolve(data);
      } else {
        reject(new ApiError(
          (data && data.message) || `HTTP ${xhr.status}`,
          (data && data.error) || "http_error",
          xhr.status,
        ));
      }
    };
    xhr.onerror = () => reject(new ApiError("network", "network", 0));
    xhr.send(formData);
  });
}

export const api = {
  // --- авторизация ---
  login: (login, password) => request("/api/auth/login", { method: "POST", json: { login, password } }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  me: () => request("/api/auth/me"),
  updateProfile: (payload) => request("/api/auth/profile", { method: "PATCH", json: payload }),
  messages: () => request("/api/messages"),
  sendMessage: (body) => request("/api/messages", { method: "POST", json: { body } }),
  teamMessages: () => request("/api/team/messages"),
  sendTeamMessage: (body) => request("/api/team/messages", { method: "POST", json: { body } }),
  clearTeamChat: () => request("/api/team/messages", { method: "DELETE" }),

  // --- общее состояние ---
  state: (signal) => request("/api/state", { signal }),
  leaderboard: () => request("/api/leaderboard"),

  // --- задания ---
  tasks: () => request("/api/tasks"),
  submitTask: (taskId, formData, onProgress) =>
    upload(`/api/tasks/${taskId}/submit`, formData, onProgress),
  deleteAttachment: (submissionId, attachmentId) =>
    request(`/api/submissions/${submissionId}/attachments/${attachmentId}`, { method: "DELETE" }),

  // --- голосование ---
  sections: () => request("/api/sections"),
  vote: (sectionId) => request("/api/votes", { method: "POST", json: { section_id: sectionId } }),
  projects: () => request("/api/projects"),
  likeProject: (submissionId) =>
    request("/api/projects/like", { method: "POST", json: { submission_id: submissionId } }),

  // --- тест ---
  quizState: () => request("/api/quiz/state"),
  quizAnswer: (questionId, selectedIndex) =>
    request("/api/quiz/answer", {
      method: "POST",
      json: { question_id: questionId, selected_index: selectedIndex },
    }),

  admin: {
    overview: () => request("/api/admin/overview"),
    teams: () => request("/api/admin/teams"),
    updateTeam: (teamId, payload) =>
      request(`/api/admin/teams/${teamId}`, { method: "PATCH", json: payload }),
    updateUser: (userId, payload) =>
      request(`/api/admin/users/${userId}`, { method: "PATCH", json: payload }),
    setLeader: (teamId, userId) =>
      request(`/api/admin/teams/${teamId}/leader/${userId}`, { method: "POST" }),
    moveUser: (userId, teamId) =>
      request(`/api/admin/users/${userId}/move/${teamId}`, { method: "POST" }),
    adjustScore: (teamId, payload) =>
      request(`/api/admin/teams/${teamId}/score`, { method: "POST", json: payload }),
    adjustments: (teamId) => request(`/api/admin/teams/${teamId}/adjustments`),
    submissions: (params = "") => request(`/api/admin/submissions${params}`),
    gradeSubmission: (submissionId, points) =>
      request(`/api/admin/submissions/${submissionId}/points`, {
        method: "PATCH",
        json: { points },
      }),
    deleteSubmission: (submissionId) =>
      request(`/api/admin/submissions/${submissionId}`, { method: "DELETE" }),
    resetSubmissions: (payload = {}) =>
      request("/api/admin/submissions/reset", { method: "POST", json: payload }),
    resetScores: () => request("/api/admin/scores/reset", { method: "POST" }),
    tasks: () => request("/api/admin/tasks"),
    createTask: (payload) => request("/api/admin/tasks", { method: "POST", json: payload }),
    updateTask: (taskId, payload) =>
      request(`/api/admin/tasks/${taskId}`, { method: "PATCH", json: payload }),
    deleteTask: (taskId) => request(`/api/admin/tasks/${taskId}`, { method: "DELETE" }),
    toggleQuiz: (payload) => request("/api/admin/quiz/toggle", { method: "POST", json: payload }),
    quizControl: (action, payload = {}) =>
      request("/api/admin/quiz/control", { method: "POST", json: { action, ...payload } }),
    quizSettings: (payload) =>
      request("/api/admin/quiz/settings", { method: "POST", json: payload }),
    resetQuiz: () => request("/api/admin/quiz/reset", { method: "POST" }),
    quizResults: () => request("/api/quiz/results"),
    quizQuestions: () => request("/api/admin/quiz/questions"),
    allVotes: () => request("/api/votes/all"),
    updateSection: (sectionId, payload) =>
      request(`/api/admin/sections/${sectionId}`, { method: "PATCH", json: payload }),
    resetVotes: () => request("/api/admin/votes/reset", { method: "POST" }),
    rounds: () => request("/api/admin/rounds"),
    roundControl: (taskId, action, payload = {}) =>
      request(`/api/admin/rounds/${taskId}/control`, { method: "POST", json: { action, ...payload } }),
    roundSettings: (taskId, payload) =>
      request(`/api/admin/rounds/${taskId}/settings`, { method: "POST", json: payload }),
    resetProjectVotes: () => request("/api/admin/projects/reset", { method: "POST" }),
    messageThreads: () => request("/api/admin/messages"),
    messageThread: (userId) => request(`/api/admin/messages/${userId}`),
    replyMessage: (userId, body) =>
      request(`/api/admin/messages/${userId}`, { method: "POST", json: { body } }),
    resetMessages: () => request("/api/admin/messages/reset", { method: "POST" }),
  },
};
