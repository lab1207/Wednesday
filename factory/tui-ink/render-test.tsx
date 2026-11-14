import React from 'react'
import { renderToString } from 'ink'
import { InkStore } from './store'
import { InkApp } from './frame'

const store = new InkStore()
store.setHeader({ model: 'qwen2.5-coder-3b', workspace: 'C:\\wednesday', mode: 'ACT' })
store.line('Welcome to Wednesday!', 'bold')
store.line('Type your message below, or / for commands.', 'dim')
store.line('')
store.setSide([{ text: 'all roles: qwen2.5-coder-3b', tone: 'dim' }, { text: 'shape: auto', tone: 'dim' }])
store.setInput('hello world')

const output = renderToString(<InkApp store={store} />)
if (!output.includes('WEDNESDAY') || !output.includes('roles & models') || !output.includes('hello world')) {
  throw new Error('render test missing expected content')
}
console.log(output)
