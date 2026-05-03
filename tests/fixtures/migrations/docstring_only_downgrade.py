"""Migration with a docstring-only downgrade."""

revision = "002"
down_revision = "001"


def upgrade():
    op.create_table("orders")


def downgrade():
    """Cannot reverse this migration."""
