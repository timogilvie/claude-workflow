"""Migration with an empty pass-only downgrade."""

revision = "001"
down_revision = None


def upgrade():
    op.create_table("widgets")


def downgrade():
    pass
