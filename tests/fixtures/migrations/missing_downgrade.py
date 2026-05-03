"""Migration with no downgrade() defined at all."""

revision = "006"
down_revision = "005"


def upgrade():
    op.add_column("widgets", "label")
