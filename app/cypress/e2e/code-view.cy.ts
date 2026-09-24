describe('Code view', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.get('[aria-label="View"]').contains('Code').click()
  })

  function openReadme() {
    cy.get('[aria-label="Project files"]')
      .contains('button', 'README.md')
      .click()
    cy.get('.cm-content').should('exist')
  }

  it('opens a file, edits it, saves, and closes the tab', () => {
    openReadme()
    cy.get('[role="tab"]').should('contain.text', 'README.md')
    cy.get('.cm-content').type(' edited')
    cy.contains('span', 'Unsaved').should('exist')
    cy.contains('button', 'Save').click()
    cy.contains('span', 'Saved').should('exist')
    cy.get('[aria-label^="Close "]').click()
    cy.get('[role="tab"]').should('not.exist')
    cy.contains('No file open').should('exist')
  })

  it('confirms before closing a dirty tab and can keep it open', () => {
    openReadme()
    cy.get('.cm-content').type(' dirty')
    cy.get('[aria-label^="Close "]').click()
    cy.contains('Discard unsaved changes?').should('exist')
    cy.contains('button', 'Keep').click()
    cy.get('[role="tab"]').should('have.length', 1)
    cy.contains('button', 'Discard').click()
    cy.get('[role="tab"]').should('not.exist')
  })

  it('reverts unsaved edits back to the on-disk content', () => {
    openReadme()
    cy.get('.cm-content').type(' temporary')
    cy.contains('button', 'Revert').click()
    cy.contains('span', 'Saved').should('exist')
  })
})
