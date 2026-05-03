"""Migration with a docstring + pass downgrade."""

revision = "003"
down_revision = "002"


def upgrade():
    op.add_column("orders", "discount_pct")


def downgrade():
    """Skip downgrade for this revision."""
    pass
