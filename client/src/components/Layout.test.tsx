import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import Layout from './Layout'

const renderWithProviders = (component: React.ReactElement) => {
  return render(
    <FluentProvider theme={webLightTheme}>
      <BrowserRouter>
        {component}
      </BrowserRouter>
    </FluentProvider>
  )
}

describe('Layout', () => {
  it('renders Photrix brand', () => {
    renderWithProviders(<Layout />)
    expect(screen.getByText('Photrix')).toBeInTheDocument()
  })

  it('renders navigation buttons', () => {
    renderWithProviders(<Layout />)
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
    expect(screen.getByLabelText('Settings')).toBeInTheDocument()
    expect(screen.getByLabelText('Profile')).toBeInTheDocument()
  })
})