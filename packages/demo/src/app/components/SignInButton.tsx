interface SignInButtonProps {
  submitting: boolean
  label?: string
  submittingLabel?: string
}

/**
 * Shared "Sign in with Certified" button used across all demo login pages.
 */
export function SignInButton({
  submitting,
  label = 'Sign in with Certified',
  submittingLabel = 'Redirecting...',
}: SignInButtonProps) {
  return (
    <button
      type="submit"
      disabled={submitting}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '14px 28px',
        fontSize: '16px',
        fontWeight: 500,
        color: '#ffffff',
        background: submitting ? '#4a4a4a' : '#2563eb',
        border: 'none',
        borderRadius: '8px',
        cursor: submitting ? 'default' : 'pointer',
        letterSpacing: '0.3px',
        opacity: submitting ? 0.7 : 1,
      }}
    >
      {submitting ? (
        submittingLabel
      ) : (
        <>
          <img
            src="/certified-logo.png"
            alt=""
            style={{ height: '20px', marginRight: '12px' }}
          />
          {label}
        </>
      )}
    </button>
  )
}
