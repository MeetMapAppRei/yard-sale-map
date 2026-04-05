import { Component } from 'react'

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100%',
            padding: 24,
            background: '#0f172a',
            color: '#fecaca',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <p style={{ fontWeight: 700, margin: '0 0 12px' }}>Something went wrong</p>
          <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: '#cbd5e1' }}>
            Try refreshing the page. If this keeps happening after you collapse a sale card, let us know.
          </p>
          <pre
            style={{
              fontSize: 12,
              overflow: 'auto',
              padding: 12,
              background: '#1e293b',
              borderRadius: 8,
              color: '#94a3b8',
            }}
          >
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
