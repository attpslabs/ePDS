import { AppLogo } from './AppLogo'

interface PageShellProps {
  children: React.ReactNode
}

/**
 * Shared outer layout used by all demo login pages: full-viewport centred
 * container with the ePDS Demo logo and h1.
 */
export function PageShell({ children }: PageShellProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        padding: '20px',
        overflow: 'hidden',
        background: '#f8f9fa',
      }}
    >
      <div
        style={{
          maxWidth: '440px',
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div style={{ marginBottom: '24px' }}>
          <AppLogo size={64} />
          <h1
            style={{
              fontSize: '22px',
              fontWeight: 600,
              color: '#1a1a2e',
              margin: '12px 0 4px',
            }}
          >
            ePDS Demo
          </h1>
        </div>
        {children}
        {process.env.NEXT_PUBLIC_EPDS_VERSION && (
          <p
            style={{
              marginTop: '32px',
              fontSize: '12px',
              color: '#999',
            }}
          >
            ePDS {process.env.NEXT_PUBLIC_EPDS_VERSION}
          </p>
        )}
      </div>
    </div>
  )
}
