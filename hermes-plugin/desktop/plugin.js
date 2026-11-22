/**
 * Sous Chef page for Hermes Desktop.
 *
 * Shows the Sous Chef editor inside Hermes. The editor itself is served by
 * the local edit server, the same one the Sous Chef desktop app uses, so an
 * edit made in either place appears in the other.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, not JSX syntax.
 */
import { Button, ErrorState, GlyphSpinner, host, PALETTE_AREA, ROUTES_AREA, SandboxedFrame, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'sous-chef'
const ROUTE = '/sous-chef'
const LAST_PROJECT = 'lastProject'
const PROJECT_ID = /^[a-f0-9]{6,64}$/

function editorUrl(conn, projectId) {
  const url = new URL(conn.url)
  url.searchParams.set('token', conn.token)
  url.searchParams.set('embed', 'hermes')
  if (projectId) url.searchParams.set('project', projectId)
  return url.toString()
}

function EditorPage({ ctx }) {
  const [state, setState] = useState({ phase: 'loading' })
  const frame = useRef(null)

  const connect = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      const conn = await ctx.rest('/connection', { method: 'POST', timeoutMs: 25000 })
      if (!conn || typeof conn.url !== 'string' || typeof conn.token !== 'string') throw new Error('The server gave no address.')
      const saved = await ctx.storage.get(LAST_PROJECT)
      setState({ phase: 'ready', src: editorUrl(conn, typeof saved === 'string' && PROJECT_ID.test(saved) ? saved : null) })
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [ctx])

  useEffect(() => {
    void connect()
  }, [connect])

  // The editor reports which project is open, so the page can reopen it next time.
  useEffect(() => {
    const onMessage = event => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const data = event.data
      if (!data || data.type !== 'sous:project') return
      if (data.projectId === null) void ctx.storage.remove(LAST_PROJECT)
      else if (typeof data.projectId === 'string' && PROJECT_ID.test(data.projectId)) void ctx.storage.set(LAST_PROJECT, data.projectId)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [ctx])

  if (state.phase === 'loading') {
    return jsxs('div', {
      className: 'flex h-full items-center justify-center gap-2 text-sm text-(--ui-text-tertiary)',
      children: [jsx(GlyphSpinner, {}), 'Starting Sous Chef…']
    })
  }
  if (state.phase === 'error') {
    return jsxs('div', {
      className: 'flex h-full flex-col items-center justify-center gap-3 p-6',
      children: [
        jsx(ErrorState, { title: 'Sous Chef could not start', description: state.message }),
        jsx(Button, { onClick: () => void connect(), children: 'Try again' })
      ]
    })
  }
  return jsx(SandboxedFrame, { ref: frame, src: state.src, title: 'Sous Chef editor', className: 'size-full' })
}

export default {
  id: ID,
  name: 'Sous Chef',
  register(ctx) {
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(EditorPage, { ctx }) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, order: 86, data: { path: ROUTE, label: 'Sous Chef', codicon: 'device-camera-video' } })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: { id: 'sous-chef.open', label: 'Open Sous Chef', keywords: ['video', 'editor', 'edit', 'timeline', 'youtube'], run: () => host.navigate(ROUTE) }
    })
  }
}
