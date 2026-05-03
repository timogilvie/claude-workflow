def upgrade():
    op.execute("select 1")


def downgrade():
    """irreversible"""
    pass
