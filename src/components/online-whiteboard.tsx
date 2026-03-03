import { useCallback, useEffect, useState } from 'react'
import { useSyncDemo } from '@tldraw/sync'
import {
  getDefaultUserPresence,
  Tldraw,
  type Editor,
  type TLPresenceStateInfo,
  type TLPresenceUserInfo,
  type TLStore,
} from 'tldraw'
import 'tldraw/tldraw.css'

type OnlineWhiteboardProps = {
  canDraw: boolean
  syncRoomId: string
  onEditorMount?: (editor: Editor | null) => void
}

export function OnlineWhiteboard({
  canDraw,
  syncRoomId,
  onEditorMount,
}: OnlineWhiteboardProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [activeTool, setActiveTool] = useState<'draw' | 'eraser'>('draw')
  const store = useSyncDemo({
    roomId: syncRoomId,
    getUserPresence: (
      storeInstance: TLStore,
      user: TLPresenceUserInfo,
    ): TLPresenceStateInfo | null => {
      if (!canDraw) {
        return null
      }
      return getDefaultUserPresence(storeInstance, user)
    },
  })

  const setTool = useCallback(
    (tool: 'draw' | 'eraser') => {
      if (!canDraw) {
        return
      }
      setActiveTool(tool)
      editor?.setCurrentTool(tool)
    },
    [canDraw, editor],
  )

  useEffect(() => {
    return () => {
      setEditor(null)
      onEditorMount?.(null)
    }
  }, [onEditorMount, syncRoomId])

  useEffect(() => {
    if (!editor) {
      return
    }
    if (!canDraw) {
      editor.setCurrentTool('hand')
      return
    }
    editor.setCurrentTool(activeTool)
  }, [activeTool, canDraw, editor])

  return (
    <div className="relative mt-4 overflow-hidden rounded-2xl border-[3px] border-[var(--line)] bg-white">
      <div className="h-[52vh] min-h-[340px] w-full sm:h-[58vh]">
        <Tldraw
          store={store}
          hideUi
          components={{
            ContextMenu: null,
          }}
          inferDarkMode={false}
          onMount={(editor) => {
            setEditor(editor)
            editor.setCurrentTool(canDraw ? activeTool : 'hand')
            onEditorMount?.(editor)
          }}
        />
      </div>

      {canDraw ? (
        <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 gap-2 rounded-2xl border-[3px] border-[var(--line)] bg-[rgba(255,255,255,0.96)] p-2">
          <button
            type="button"
            className={`px-4 py-2 text-xs font-extrabold ${
              activeTool === 'draw' ? 'bg-[var(--mint)]' : 'bg-white'
            }`}
            onClick={() => setTool('draw')}
          >
            Draw
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-xs font-extrabold ${
              activeTool === 'eraser' ? 'bg-[var(--orange)]' : 'bg-white'
            }`}
            onClick={() => setTool('eraser')}
          >
            Eraser
          </button>
        </div>
      ) : (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-transparent pt-3">
          <div className="rounded-xl border-[3px] border-[var(--line)] bg-[rgba(255,255,255,0.92)] px-3 py-2 text-xs font-extrabold">
            Spectator Mode: only the active player can draw.
          </div>
          <div className="absolute inset-0" />
        </div>
      )}
    </div>
  )
}
