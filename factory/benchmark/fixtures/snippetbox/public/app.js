/**
 * SnippetBox frontend — STUBBED for the benchmark.
 *
 * Task: wire this page to the API:
 *  1. POST /api/auth/login with { username, password } from the form.
 *  2. Store the returned token.
 *  3. Show the notes section, then GET /api/notes and POST /api/notes
 *     using the stored token as a `Bearer` header.
 */

const form = document.getElementById('login-form')
const loginError = document.getElementById('login-error')
const notesSection = document.getElementById('notes')
const noteForm = document.getElementById('note-form')
const noteList = document.getElementById('note-list')
const noteContent = document.getElementById('note-content')

// TODO(benchmark): implement login and note listing/creation here.

form.addEventListener('submit', event => {
  event.preventDefault()
  // TODO(benchmark): POST /api/auth/login and hand the token to the notes UI.
  loginError.textContent = 'Not implemented yet.'
})

noteForm.addEventListener('submit', event => {
  event.preventDefault()
  // TODO(benchmark): POST /api/notes with the stored token, then refresh the list.
  noteContent.value = ''
})

function refreshNotes() {
  // TODO(benchmark): GET /api/notes with the stored token and render the list.
  noteList.replaceChildren()
}