import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

const electronHandler = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  // preload 桥是动态类型边界，事件负载的真实类型由业务侧回调自行声明，这里保持宽泛是合理的。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_event: IpcRendererEvent, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return (): void => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronHandler)
    contextBridge.exposeInMainWorld('osInfo', { platform: process.platform })
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore 不开启上下文隔离的时候，preload和页面共享同一个window对象，直接赋值。
  window.electron = electronHandler
  // @ts-ignore 同上，直接挂在osinfo上去
  window.osInfo = { platform: process.platform }
}

export type ElectronHandler = typeof electronHandler
